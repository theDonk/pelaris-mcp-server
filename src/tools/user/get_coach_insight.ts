/**
 * MCP Tool: get_coach_insight
 * Scope: coach:read
 *
 * Reads profile + recent activity to generate a contextual coaching insight.
 * Does NOT call AI — it computes insights from data patterns.
 *
 * 1.4.1 D2 (connector truth, PEL-1211): the week's session counts come from the app's
 * backend (`get_training_truth` over the coreToolsBridge), the one "Program X of Y plus
 * bonus" the app's debrief shows, instead of a count of the last 7 days of diary rows
 * against a guessed weekly target. The trailing-window volume comparison stays, but now
 * says "in the last 7 days" so it never reads as the week's count.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db, profileSubcollection } from "../../firestore-client.js";
import { scrubDocument } from "../../scrubber.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import { readTrainingTruth, type TruthReader, type TruthWeekCounts } from "../shared/training_truth.js";

/** The program truth this tool reads, injectable for tests. */
export interface CoachInsightDeps {
  truth: TruthReader;
}

/**
 * The consistency insight from the week's counts. Pure (exported for tests). The numbers are the
 * backend's; this only words them. Null when there is nothing true to say.
 */
export function consistencyInsight(counts: TruthWeekCounts | null): { type: string; text: string; confidence: "high"; context: string } | null {
  if (counts == null) return null;
  const bonus = counts.bonusCompleted > 0 ? ` (plus ${counts.bonusCompleted} bonus beyond the program)` : "";
  if (counts.basis === "program" && counts.programPlanned > 0) {
    const done = counts.programCompleted >= counts.programPlanned;
    return {
      type: "consistency",
      text: done
        ? `All ${counts.programPlanned} program sessions done this week${bonus}. Consistency is building.`
        : `${counts.programCompleted} of ${counts.programPlanned} program sessions done this week${bonus}.`,
      confidence: "high",
      context: "weekly_completion",
    };
  }
  if (counts.totalCompleted > 0) {
    return {
      type: "consistency",
      text: `${counts.totalCompleted} ${counts.totalCompleted === 1 ? "session" : "sessions"} done this week, none from a program plan.`,
      confidence: "high",
      context: "weekly_completion",
    };
  }
  return null;
}

/**
 * Human-readable label for a benchmark. Prefers an explicit display-name field
 * when present; otherwise humanizes the slug id (e.g. "bench_press_1rm" ->
 * "Bench Press 1rm") so insight text never surfaces a raw document id.
 */
function benchmarkDisplayName(bm: Record<string, unknown>): string {
  const explicit = (bm.name ?? bm.display_name ?? bm.label) as string | undefined;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const id = String(bm.id ?? "");
  return id
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function registerGetCoachInsight(
  server: McpServer,
  deps: CoachInsightDeps = { truth: readTrainingTruth },
): void {
  server.registerTool(
    "get_coach_insight",
    {
      title: "Get Coach Insight",
      description: "Get personalised coaching observations based on your recent training — consistency, fatigue, goal progress, and areas to focus on.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, title: "Get Coach Insight" },
    },
    async () => {
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

        // Parallel data fetches
        const [truth, profileSnap, diarySnap, goalsSnap, benchmarksSnap] = await Promise.all([
          deps.truth(profileId),
          db.collection("profiles").doc(profileId).get(),
          profileSubcollection(profileId, "diary")
            .orderBy("scheduled_date", "desc")
            .limit(21)
            .get(),
          profileSubcollection(profileId, "goals")
            .where("is_completed", "==", false)
            .limit(5)
            .get(),
          profileSubcollection(profileId, "benchmarks")
            .limit(10)
            .get(),
        ]);

        const profileData = profileSnap.exists ? profileSnap.data()! : {};
        const sessions = diarySnap.docs.map((d) => d.data());
        const goals = goalsSnap.docs.map((d) => d.data());
        const benchmarks = benchmarksSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

        // Compute insights from data
        const insights: Array<{ type: string; text: string; confidence: "high" | "medium" | "low"; context: string }> = [];

        // 1. Training consistency: this week's counts, from the app's backend.
        const now = new Date();
        const sevenDaysAgo = new Date(now);
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const sevenDaysAgoStr = sevenDaysAgo.toISOString().slice(0, 10);

        // The week's counts are the app's (get_training_truth): the same "Program X of Y plus bonus".
        const consistency = consistencyInsight(truth?.weekCounts ?? null);
        if (consistency) insights.push(consistency);

        // 2. RPE trend
        const rpeSessions = sessions
          .filter((s) => s.feedback?.rpe != null)
          .slice(0, 7);
        if (rpeSessions.length >= 3) {
          const avgRpe = rpeSessions.reduce((sum, s) => sum + (s.feedback.rpe as number), 0) / rpeSessions.length;
          if (avgRpe >= 8) {
            insights.push({
              type: "fatigue",
              text: `Average RPE of ${avgRpe.toFixed(1)} across recent sessions — fatigue is building. Consider a lighter session or active recovery.`,
              confidence: "high",
              context: "rpe_trajectory",
            });
          } else if (avgRpe <= 5) {
            insights.push({
              type: "intensity",
              text: `Average RPE of ${avgRpe.toFixed(1)} — there may be room to push harder. Progressive overload drives adaptation.`,
              confidence: "medium",
              context: "rpe_trajectory",
            });
          }
        }

        // 3. Goal proximity
        for (const goal of goals) {
          if (goal.target_date) {
            const targetDate = new Date(goal.target_date);
            const daysUntil = Math.ceil((targetDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
            if (daysUntil > 0 && daysUntil <= 30) {
              insights.push({
                type: "goal_proximity",
                text: `Goal "${goal.description}" is ${daysUntil} days away. Now is the time to sharpen focus.`,
                confidence: "high",
                context: "goal_deadline",
              });
            }
          }
        }

        // 4. Benchmark progress
        for (const bm of benchmarks) {
          const history = ((bm as Record<string, unknown>).history || []) as Array<Record<string, unknown>>;
          if (history.length >= 2) {
            const latest = history[history.length - 1];
            const previous = history[history.length - 2];
            const latestVal = latest.value as number;
            const prevVal = previous.value as number;
            if (latestVal > prevVal) {
              const pctChange = ((latestVal - prevVal) / prevVal) * 100;
              if (pctChange >= 5) {
                insights.push({
                  type: "benchmark_progress",
                  text: `${benchmarkDisplayName(bm)} improved ${pctChange.toFixed(1)}%, from ${prevVal} to ${latestVal}. Progress is trending in the right direction.`,
                  confidence: "high",
                  context: "benchmark_improvement",
                });
              }
            }
          }
        }

        // 5. Volume trend (compare last 7 days vs previous 7 days)
        const fourteenDaysAgo = new Date(now);
        fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
        const fourteenDaysAgoStr = fourteenDaysAgo.toISOString().slice(0, 10);

        const thisWeekCompleted = sessions.filter(
          (s) => (s.status === "completed" || s.is_completed) && s.scheduled_date >= sevenDaysAgoStr,
        ).length;
        const lastWeekCompleted = sessions.filter(
          (s) =>
            (s.status === "completed" || s.is_completed) &&
            s.scheduled_date >= fourteenDaysAgoStr &&
            s.scheduled_date < sevenDaysAgoStr,
        ).length;

        if (thisWeekCompleted > 0 && lastWeekCompleted > 0) {
          const volumeDiff = thisWeekCompleted - lastWeekCompleted;
          if (volumeDiff >= 2) {
            insights.push({
              type: "volume_trend",
              text: `Training volume is increasing: ${thisWeekCompleted} sessions in the last 7 days vs ${lastWeekCompleted} in the 7 days before. Monitor recovery to sustain the ramp.`,
              confidence: "medium",
              context: "volume_increasing",
            });
          } else if (volumeDiff <= -2) {
            insights.push({
              type: "volume_trend",
              text: `Training volume dropped: ${thisWeekCompleted} sessions in the last 7 days vs ${lastWeekCompleted} in the 7 days before. If intentional (recovery), that's smart. If not, time to re-engage.`,
              confidence: "medium",
              context: "volume_decreasing",
            });
          } else {
            insights.push({
              type: "volume_trend",
              text: `Training volume is stable: ${thisWeekCompleted} sessions in the last 7 days, ${lastWeekCompleted} in the 7 days before. Consistency is the foundation.`,
              confidence: "medium",
              context: "volume_stable",
            });
          }
        }

        // 6. Goal progress (for goals without a target date)
        const goalsWithoutDate = goals.filter((g) => !g.target_date);
        if (goalsWithoutDate.length > 0 && sessions.length > 7) {
          insights.push({
            type: "goal_progress",
            text: `You have ${goalsWithoutDate.length} active goal${goalsWithoutDate.length > 1 ? "s" : ""} without a target date. Setting a deadline sharpens focus and drives action.`,
            confidence: "medium",
            context: "goal_no_deadline",
          });
        }

        // Fallback if no insights generated
        if (insights.length === 0) {
          insights.push({
            type: "general",
            text: "Keep logging sessions and updating benchmarks — the more data you provide, the more specific coaching insights become.",
            confidence: "low",
            context: "insufficient_data",
          });
        }

        // `context` is an internal telemetry label; keep it server-side only and
        // omit it from the returned content.
        const clientInsights = insights.slice(0, 5).map(({ context: _context, ...rest }) => rest);
        const result = scrubDocument({
          insights: clientInsights, // Cap at 5 most relevant
          ...(truth?.weekCounts ? { weekCounts: { weekStarting: truth.week.weekId, weekEnding: truth.week.weekEndId, ...truth.weekCounts } } : {}),
          generatedAt: new Date().toISOString(),
        } as Record<string, unknown>);

        logToolCall({
          requestId,
          tool: "get_coach_insight",
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
          tool: "get_coach_insight",
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
