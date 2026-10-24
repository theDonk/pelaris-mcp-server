/**
 * MCP Tool: get_onboarding_status
 * Scope: profile:read
 *
 * Returns the user's onboarding completion status.
 *
 * Connector rev 2.1 (M1, M2): "does this person have a program" is the app's `hasPlan` rule,
 * read from the person's own list through the gateway's pinned copy (`onboardingFactsOf`), the
 * same fact `generate_program` reads. It used to be "any queue doc whose status is not
 * archived", so a program removed in the app, or paused, still read as a program (or as none).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db, profileSubcollection } from "../../firestore-client.js";
import { heldPlanQueueIdOf } from "../shared/program-utils.js";
import { scrubDocument } from "../../scrubber.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import { hasPlan } from "../../connector/return_hook.js";

/**
 * B2a C6 (f), panel P3 m8: closed, structural hints for the assistant.
 * `next_step` names the tool that moves the person forward; the server
 * instructions tell the model to offer the plan in the conversation while it
 * is `complete_intake` or `generate_program`. The model chooses the words.
 */
export type OnboardingNextStep = "complete_intake" | "generate_program" | "train_today";

export function onboardingNextStep(facts: { hasCompletedOnboarding: boolean; hasProgram: boolean }): OnboardingNextStep {
  if (facts.hasProgram) return "train_today";
  return facts.hasCompletedOnboarding ? "generate_program" : "complete_intake";
}

/**
 * The two facts `next_step` reads, from the profile alone: whether the intake is complete (the app's
 * own marker, `currentIntakeRunId`) and whether the person holds a program (the app's `hasPlan`
 * rule through the gateway's pinned copy: a paused or rested program counts, a removed one and the
 * manual-workouts container do not). `get_onboarding_status` and `generate_program` both read this,
 * so the two can never disagree about where the person is (connector rev 2.1, M1).
 */
export function onboardingFactsOf(
  profile: Record<string, unknown> | null | undefined,
): { hasCompletedOnboarding: boolean; hasProgram: boolean } {
  return { hasCompletedOnboarding: !!profile?.["currentIntakeRunId"], hasProgram: hasPlan(profile) };
}

/** The units the person chose (the app writes both fields), so the chat never asks again. */
export function preferredUnitsOf(profile: Record<string, unknown>): "metric" | "imperial" | null {
  const preferences = profile.preferences as Record<string, unknown> | undefined;
  for (const value of [profile.preferredUnits, preferences?.preferred_units]) {
    if (value === "metric" || value === "imperial") return value;
  }
  return null;
}

/** The reads this tool makes, injectable for tests; production reads the person's own documents. */
export interface OnboardingStatusDeps {
  readProfile: (profileId: string) => Promise<Record<string, unknown> | null>;
  /** One queue document of the person's own, by id. */
  readQueue: (profileId: string, queueId: string) => Promise<Record<string, unknown> | null>;
  hasConnectedDevice: (profileId: string) => Promise<boolean>;
}

const DEFAULT_DEPS: OnboardingStatusDeps = {
  readProfile: async (profileId) => {
    const snap = await db.collection("profiles").doc(profileId).get();
    return snap.exists ? (snap.data() as Record<string, unknown>) : null;
  },
  readQueue: async (profileId, queueId) => {
    const snap = await profileSubcollection(profileId, "queues").doc(queueId).get();
    return snap.exists ? (snap.data() as Record<string, unknown>) : null;
  },
  hasConnectedDevice: async (profileId) => {
    try {
      const snap = await profileSubcollection(profileId, "integrations").where("status", "==", "connected").limit(1).get();
      return !snap.empty;
    } catch {
      // Integrations subcollection may not exist yet: default to false
      return false;
    }
  },
};

export function registerGetOnboardingStatus(server: McpServer, deps: OnboardingStatusDeps = DEFAULT_DEPS): void {
  server.registerTool(
    "get_onboarding_status",
    {
      title: "Get Onboarding Status",
      description: "Check your account setup progress: intake completion, sport selection, whether you have a program, and device connections.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, title: "Get Onboarding Status" },
    },
    async () => {
      const requestId = generateRequestId();
      const start = Date.now();

      try {
        const claims = getRequestAuth();
        if (!claims || !hasScope(claims.scope, "profile:read")) {
          return {
            content: [{ type: "text" as const, text: "Error: profile:read scope required" }],
            isError: true,
          };
        }

        const profileId = claims.profile_id;

        const d = await deps.readProfile(profileId);

        if (d === null) {
          return {
            content: [{ type: "text" as const, text: "Profile not found" }],
            isError: true,
          };
        }

        const { hasCompletedOnboarding, hasProgram } = onboardingFactsOf(d);

        // Infer sport from the program the person holds if the profile sport is null
        let sport: string | null = (d.intakeSummary as { primaryGoal?: string } | undefined)?.primaryGoal || null;
        if (!sport && hasProgram) {
          const heldQueueId = heldPlanQueueIdOf(d);
          const queueData = heldQueueId === null ? null : await deps.readQueue(profileId, heldQueueId);
          if (queueData !== null) {
            sport = (queueData.sport as string | undefined) || (queueData.methodology_id as string | undefined)?.split("_")[0] || null;
          }
        }

        const hasConnectedDevice = await deps.hasConnectedDevice(profileId);

        // Return only the first name (given name). The scrubber's PII field list
        // can't safely redact a bare `name` key globally (it would also strip
        // legitimate `name` fields such as exercise movement names in other
        // tools), so we minimise here instead.
        const firstName =
          typeof d.name === "string" && d.name.trim()
            ? d.name.trim().split(/\s+/)[0]
            : null;

        const status = {
          name: firstName,
          hasCompletedOnboarding,
          hasSport: !!sport,
          hasProgram,
          next_step: onboardingNextStep({ hasCompletedOnboarding, hasProgram }),
          preferred_units: preferredUnitsOf(d),
          hasConnectedDevice,
          sport,
          experienceLevel: (d.training_context as { experience_level?: string } | undefined)?.experience_level || null,
          memberSince: (d.created_at as { toDate?: () => { toISOString?: () => string } } | undefined)?.toDate?.()?.toISOString?.() || null,
          subscriptionTier: d.subscription_tier || "free",
          isFoundingMember: d.founding_member || false,
        };

        const result = scrubDocument(status as Record<string, unknown>);

        logToolCall({
          requestId,
          tool: "get_onboarding_status",
          userPseudonym: claims.sub,
          latencyMs: Date.now() - start,
          success: true,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        logToolCall({
          requestId,
          tool: "get_onboarding_status",
          latencyMs: Date.now() - start,
          success: false,
          error: (error as Error).message,
        });
        return {
          content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
