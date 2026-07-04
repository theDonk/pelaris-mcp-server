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
  server.registerTool(
    "get_onboarding_status",
    {
      title: "Get Onboarding Status",
      description: "Check your account setup progress — intake completion, sport selection, program creation, and device connections.",
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

        // Filter to non-archived queues (PEL-220 fix parity)
        const activeQueueDocs = queuesSnap.docs.filter((doc) => doc.data().status !== "archived");

        // Infer sport from active program if profile sport is null
        let sport: string | null = d.intakeSummary?.primaryGoal || null;
        if (!sport && activeQueueDocs.length > 0) {
          const queueData = activeQueueDocs[0].data();
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
          hasCompletedOnboarding: !!d.currentIntakeRunId,
          hasSport: !!sport,
          hasProgram: activeQueueDocs.length > 0,
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
