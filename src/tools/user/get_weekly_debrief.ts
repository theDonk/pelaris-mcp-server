/**
 * MCP Tool: get_weekly_debrief
 * Scope: coach:read
 *
 * Returns the user's weekly training debrief. The debrief is the one the app shows:
 * the week is chosen by the app's own rule (Friday 17:00 in the athlete's timezone) and
 * the counts are the app's "Program X of Y plus bonus", both read from the app's backend
 * (`get_training_truth` over the coreToolsBridge).
 *
 * 1.4.1 D2 (connector truth). Before this the tool read the stored debrief
 * itself and quoted its all-origins "planned" figure, so the metrics said "5 of 21"
 * while the debrief's own text said 13, and it listed existing benchmarks as "PRs"
 * beside "no new PRs". Now `sessionsCompleted` and `sessionsPlanned` are the program
 * pair (the same as the narrative), bonus sessions are their own field, and benchmarks
 * are labelled as current benchmarks. Existing field names are kept.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { scrubDocument } from "../../scrubber.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import {
  TRUTH_UNAVAILABLE_MESSAGE,
  plainDay,
  readTrainingTruth,
  type TruthDebrief,
  type TruthReader,
} from "../shared/training_truth.js";

/** The program truth this tool reads, injectable for tests. */
export interface WeeklyDebriefDeps {
  truth: TruthReader;
}

/**
 * The tool's answer for one debrief. Pure (exported for tests). A debrief written before the
 * program pair existed falls back to its stored all-sessions figures, labelled as such.
 */
export function shapeDebrief(d: TruthDebrief, weekRequested: string | null): Record<string, unknown> {
  const m = d.metrics ?? {};
  const counts = m.weekCounts;
  const program = counts != null && counts.basis === "program";
  const completed = program ? counts.programCompleted : (m.sessionsCompleted ?? 0);
  const planned = program ? counts.programPlanned : (m.sessionsPlanned ?? 0);
  const benchmarks = m.currentBenchmarks ?? m.benchmarkPRs ?? [];
  const weekOf = plainDay(d.weekStarting);
  return {
    ...(d.fallback
      ? {
          note: weekRequested != null
            ? `No debrief found for the week of ${plainDay(weekRequested) ?? weekRequested}. Showing the most recent debrief.`
            : "Showing the most recent debrief.",
        }
      : {}),
    weekStarting: d.weekStarting,
    summary: d.summary ?? null,
    metrics: {
      // The program pair: what the debrief's text counts. Bonus sessions are separate and never a shortfall.
      sessionsCompleted: completed,
      sessionsPlanned: planned,
      completionRate: planned > 0 ? Math.round((completed / planned) * 100) : 0,
      avgRpe: m.avgRpe ?? null,
      // Kept under its old name; these are the athlete's current benchmarks, not new records.
      benchmarkPRs: benchmarks,
      improvingExercises: m.improvingExercises ?? [],
      plateauExercises: m.plateauExercises ?? [],
      ...(counts != null
        ? {
            bonusSessions: counts.bonusCompleted,
            totalSessionsCompleted: counts.totalCompleted,
            weekCounts: counts.line,
            countsBasis: counts.basis,
            ...(counts.basis === "all_sessions_legacy"
              ? { countsNote: "This debrief was written before program sessions were counted separately, so the figures cover every session." }
              : {}),
          }
        : {}),
      currentBenchmarks: benchmarks,
      currentBenchmarksNote: "Your current benchmark values. They are not new personal records; those are listed under newPrs.",
      newPrs: m.newPrs ?? [],
    },
    ...(weekOf != null ? { weekLabel: `Week of ${weekOf}` } : {}),
    nextWeekFocus: d.nextWeekFocus ?? null,
    generatedAt: d.generatedAt ?? null,
  };
}

export function registerGetWeeklyDebrief(
  server: McpServer,
  deps: WeeklyDebriefDeps = { truth: readTrainingTruth },
): void {
  server.registerTool(
    "get_weekly_debrief",
    {
      title: "Get Weekly Debrief",
      description: "View your weekly training summary — session completion, highlights, areas for improvement, and next week's focus.",
      inputSchema: {
        weekDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
          .optional()
          .describe("A date within the target week (YYYY-MM-DD). Defaults to the current week."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true, title: "Get Weekly Debrief" },
    },
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
        const truth = await deps.truth(profileId, {
          includeDebrief: true,
          ...(params.weekDate ? { weekDate: params.weekDate } : {}),
        });
        if (truth == null) {
          logToolCall({ requestId, tool: "get_weekly_debrief", userPseudonym: claims.sub, latencyMs: Date.now() - start, success: false, error: "truth_unavailable" });
          return { content: [{ type: "text" as const, text: `Error: ${TRUTH_UNAVAILABLE_MESSAGE}` }], isError: true };
        }

        const result = truth.debrief
          ? scrubDocument(shapeDebrief(truth.debrief, params.weekDate ?? null))
          : scrubDocument({
              weekStarting: truth.week.weekId,
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
