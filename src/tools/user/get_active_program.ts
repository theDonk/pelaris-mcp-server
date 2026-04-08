/**
 * MCP Tool: get_active_program
 * Scope: training:read
 *
 * Returns the user's active training program(s) with structure details.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { profileSubcollection } from "../../firestore-client.js";
import { scrubDocument } from "../../scrubber.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { logToolCall, generateRequestId } from "../../logger.js";

export function registerGetActiveProgram(server: McpServer): void {
  server.tool(
    "get_active_program",
    "View your current training programs with progress, phase, weekly structure, and session details.",
    {},
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async () => {
      const requestId = generateRequestId();
      const start = Date.now();

      try {
        const claims = getRequestAuth();
        if (!claims || !hasScope(claims.scope, "training:read")) {
          return {
            content: [{ type: "text" as const, text: "Error: training:read scope required" }],
            isError: true,
          };
        }

        const profileId = claims.profile_id;
        const queuesSnap = await profileSubcollection(profileId, "queues")
          .limit(10)
          .get();

        if (queuesSnap.empty) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ programs: [], message: "No active programs found" }) }],
          };
        }

        // Filter to non-archived programs (matches manage_program.ts pattern)
        const activeDocs = queuesSnap.docs.filter((doc) => {
          const d = doc.data();
          return d.status !== "archived";
        });

        if (activeDocs.length === 0) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ programs: [], message: "No active programs found" }) }],
          };
        }

        const programs = activeDocs.map((doc) => {
          const d = doc.data();
          const sessions = (d.sessions || []) as Array<Record<string, unknown>>;
          const completed = sessions.filter((s) => s.is_completed).length;
          const weeks = [...new Set(sessions.map((s) => s.week_number as number))].sort((a, b) => a - b);

          // Find the current week (first week with incomplete sessions)
          const currentWeek = weeks.find((w) =>
            sessions.some((s) => s.week_number === w && !s.is_completed),
          ) || weeks[weeks.length - 1] || 1;

          // Get session structure for current week
          const currentWeekSessions = sessions
            .filter((s) => s.week_number === currentWeek)
            .map((s) => ({
              sessionId: s.id,
              focus: s.focus || null,
              slotType: s.slot_type || null,
              isCompleted: s.is_completed || false,
              scheduledDate: s.scheduled_date || null,
              hasCoachNote: !!s.coach_note,
              adaptationApplied: s.adaptation_applied || false,
            }));

          // Macro structure (phases)
          const macroStructure = (d.macro_structure || []) as Array<Record<string, unknown>>;
          const currentPhase = macroStructure.find((phase) => {
            const phaseWeeks = phase.weeks as number[];
            return phaseWeeks?.includes(currentWeek);
          });

          return {
            queueId: doc.id,
            title: d.title,
            methodologyId: d.methodology_id,
            sourceProgramId: d.source_program_id,
            type: d.type,
            totalSessions: sessions.length,
            completedSessions: completed,
            completionPercent: sessions.length > 0 ? Math.round((completed / sessions.length) * 100) : 0,
            totalWeeks: weeks.length,
            currentWeek,
            currentPhase: currentPhase ? {
              phase: currentPhase.phase,
              focus: currentPhase.focus,
            } : null,
            currentWeekSessions,
            weeklyOverviews: d.weekly_overviews || null,
            generationStatus: d.generation_status || null,
          };
        });

        const result = scrubDocument({ programs } as Record<string, unknown>);

        logToolCall({
          requestId,
          tool: "get_active_program",
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
          tool: "get_active_program",
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
