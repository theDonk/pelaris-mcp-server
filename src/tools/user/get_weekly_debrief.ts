/**
 * MCP Tool: get_weekly_debrief
 * Scope: coach:read
 *
 * Returns the user's weekly training debrief. Reads from the weekly_debriefs
 * subcollection which is populated by the server-side WeeklyDebriefService.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { profileSubcollection } from "../../firestore-client.js";
import { scrubDocument } from "../../scrubber.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { logToolCall, generateRequestId } from "../../logger.js";

/**
 * Get the Monday of the week containing the given date (ISO week).
 */
function getMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust for Sunday
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function registerGetWeeklyDebrief(server: McpServer): void {
  server.tool(
    "get_weekly_debrief",
    "View your weekly training summary — session completion, highlights, areas for improvement, and next week's focus.",
    {
      weekDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
        .optional()
        .describe("A date within the target week (YYYY-MM-DD). Defaults to the current week."),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    async (params) => {
      const requestId = generateRequestId();
      const start = Date.now();

      try {
        const claims = getRequestAuth();
        if (!claims || !hasScope(claims.scope, "coach:read")) {
          return {
            content: [{ type: "text" as const, text: "Error: coach:read scope required" }],
            isError: true,
          };
        }

        const profileId = claims.profile_id;
        const debriefsCol = profileSubcollection(profileId, "weekly_debriefs");

        // Determine the week ID (Monday date string)
        const targetDate = params.weekDate ? new Date(params.weekDate) : new Date();
        const monday = getMonday(targetDate);
        const weekId = monday.toISOString().split("T")[0];

        // Try exact match first
        const exactDoc = await debriefsCol.doc(weekId).get();

        if (exactDoc.exists) {
          const d = exactDoc.data()!;
          const result = scrubDocument({
            weekStarting: d.weekStarting || weekId,
            summary: d.summary || null,
            metrics: {
              sessionsCompleted: d.metrics?.sessionsCompleted ?? 0,
              sessionsPlanned: d.metrics?.sessionsPlanned ?? 0,
              completionRate: d.metrics?.sessionsPlanned > 0
                ? Math.round((d.metrics.sessionsCompleted / d.metrics.sessionsPlanned) * 100)
                : 0,
              avgRpe: d.metrics?.avgRpe ?? null,
              benchmarkPRs: d.metrics?.benchmarkPRs || [],
              improvingExercises: d.metrics?.improvingExercises || [],
              plateauExercises: d.metrics?.plateauExercises || [],
            },
            nextWeekFocus: d.nextWeekFocus || null,
            generatedAt: d.generatedAt || null,
          } as Record<string, unknown>);

          logToolCall({
            requestId,
            tool: "get_weekly_debrief",
            userPseudonym: claims.sub,
            latencyMs: Date.now() - start,
            success: true,
          });

          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        // No exact match — try the most recent debrief
        const recentSnap = await debriefsCol
          .orderBy("weekStarting", "desc")
          .limit(1)
          .get();

        if (!recentSnap.empty) {
          const doc = recentSnap.docs[0];
          const d = doc.data();
          const result = scrubDocument({
            note: `No debrief found for week of ${weekId}. Showing most recent debrief.`,
            weekStarting: d.weekStarting || doc.id,
            summary: d.summary || null,
            metrics: {
              sessionsCompleted: d.metrics?.sessionsCompleted ?? 0,
              sessionsPlanned: d.metrics?.sessionsPlanned ?? 0,
              completionRate: d.metrics?.sessionsPlanned > 0
                ? Math.round((d.metrics.sessionsCompleted / d.metrics.sessionsPlanned) * 100)
                : 0,
              avgRpe: d.metrics?.avgRpe ?? null,
              benchmarkPRs: d.metrics?.benchmarkPRs || [],
              improvingExercises: d.metrics?.improvingExercises || [],
              plateauExercises: d.metrics?.plateauExercises || [],
            },
            nextWeekFocus: d.nextWeekFocus || null,
            generatedAt: d.generatedAt || null,
          } as Record<string, unknown>);

          logToolCall({
            requestId,
            tool: "get_weekly_debrief",
            userPseudonym: claims.sub,
            latencyMs: Date.now() - start,
            success: true,
          });

          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        // No debriefs at all
        const result = scrubDocument({
          weekStarting: weekId,
          message: "No weekly debriefs available yet. Debriefs are generated automatically after a week of training activity.",
        } as Record<string, unknown>);

        logToolCall({
          requestId,
          tool: "get_weekly_debrief",
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
          tool: "get_weekly_debrief",
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
