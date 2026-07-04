/**
 * MCP Tool: list_goals
 * Scope: training:read OR training:write
 *
 * Read-only listing of the user's training goals. Split out of manage_goals
 * (connector-cert polish — DESIGN.md Item 3) so the read surface is no longer
 * gated behind a destructiveHint:true write tool. The write actions
 * (create/update/complete) stay on manage_goals.
 *
 * Scope: accepts training:read OR training:write. A write-scoped client could
 * already list under manage_goals{action:"list"}, so accepting either scope
 * means no client that can list today regresses.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { profileSubcollection } from "../../firestore-client.js";
import { scrubDocument } from "../../scrubber.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { logToolCall, generateRequestId } from "../../logger.js";

type ToolTextResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/**
 * Shared goal-listing logic, called by both this tool and the deprecated
 * manage_goals{action:"list"} alias so there is one source of truth. Reads the
 * goals subcollection ordered by date_created desc (limit 50) and returns a
 * PII-scrubbed result. Auth/scope enforcement and logging stay in the caller.
 */
export async function listGoalsResult(profileId: string): Promise<ToolTextResult> {
  const goalsCol = profileSubcollection(profileId, "goals");
  const goalsSnap = await goalsCol.orderBy("date_created", "desc").limit(50).get();

  if (goalsSnap.empty) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ goals: [], message: "No goals found" }) }],
    };
  }

  const goals = goalsSnap.docs.map((doc) => {
    const d = doc.data();
    return {
      goalId: doc.id,
      description: d.description,
      isCompleted: d.is_completed || false,
      dateCreated: d.date_created || null,
      targetDate: d.target_date || null,
      targetValue: d.target_value ?? null,
      targetMetric: d.target_metric || null,
      targetDirection: d.target_direction || null,
      source: d.source || null,
      eventName: d.event_name || null,
      eventDate: d.event_date || null,
      eventDistance: d.event_distance || null,
      eventLocation: d.event_location || null,
      // Benchmark ids this goal is tracked against (linked at write
      // time by intake, the dashboard AI suggestion, or the coach).
      linkedBenchmarkIds: Array.isArray(d.linked_benchmark_ids)
        ? d.linked_benchmark_ids
        : [],
    };
  });

  const result = scrubDocument({ goals } as Record<string, unknown>);

  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

export function registerListGoals(server: McpServer): void {
  server.tool(
    "list_goals",
    "List your training goals — race events, body composition targets, and performance milestones — with completion status and linked benchmarks.",
    {},
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async () => {
      const requestId = generateRequestId();
      const start = Date.now();

      try {
        // Read tool: accept training:read OR training:write so a write-scoped
        // client that could already list under manage_goals does not regress.
        const claims = getRequestAuth();
        if (
          !claims ||
          (!hasScope(claims.scope, "training:read") && !hasScope(claims.scope, "training:write"))
        ) {
          return {
            content: [{ type: "text" as const, text: "Error: training:read or training:write scope required" }],
            isError: true,
          };
        }

        const result = await listGoalsResult(claims.profile_id);

        logToolCall({
          requestId,
          tool: "list_goals",
          userPseudonym: claims.sub,
          latencyMs: Date.now() - start,
          success: true,
        });

        return result;
      } catch (error) {
        logToolCall({
          requestId,
          tool: "list_goals",
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
