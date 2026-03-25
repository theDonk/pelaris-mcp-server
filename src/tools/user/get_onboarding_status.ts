/**
 * MCP Tool: get_onboarding_status
 * Scope: profile:read
 *
 * Returns the user's onboarding completion status.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db, profileSubcollection } from "../../firestore-client.js";
import { scrubDocument } from "../../scrubber.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { logToolCall, generateRequestId } from "../../logger.js";

export function registerGetOnboardingStatus(server: McpServer): void {
  server.tool(
    "get_onboarding_status",
    "Check your account setup progress — intake completion, sport selection, program creation, and device connections.",
    {},
    { readOnlyHint: true },
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

        const [profileSnap, queuesSnap] = await Promise.all([
          db.collection("profiles").doc(profileId).get(),
          profileSubcollection(profileId, "queues").limit(1).get(),
        ]);

        if (!profileSnap.exists) {
          return {
            content: [{ type: "text" as const, text: "Profile not found" }],
            isError: true,
          };
        }

        const d = profileSnap.data()!;

        // Infer sport from active program if profile sport is null
        let sport: string | null = d.intakeSummary?.primaryGoal || null;
        if (!sport && !queuesSnap.empty) {
          const queueData = queuesSnap.docs[0].data();
          sport = queueData.sport || queueData.methodology_id?.split("_")[0] || null;
        }

        // Check integrations subcollection for connected devices
        let hasConnectedDevice = false;
        try {
          const integrationsSnap = await profileSubcollection(profileId, "integrations")
            .where("status", "==", "connected")
            .limit(1)
            .get();
          hasConnectedDevice = !integrationsSnap.empty;
        } catch {
          // Integrations subcollection may not exist yet — default to false
        }

        const status = {
          name: d.name || null,
          hasCompletedOnboarding: !!d.currentIntakeRunId,
          hasSport: !!sport,
          hasProgram: !queuesSnap.empty,
          hasConnectedDevice,
          sport,
          experienceLevel: d.training_context?.experience_level || null,
          memberSince: d.created_at?.toDate?.()?.toISOString?.() || null,
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
