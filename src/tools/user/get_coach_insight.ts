/**
 * MCP Tool: get_coach_insight
 * Scope: coach:read
 *
 * Reads profile + recent activity to generate a contextual coaching insight.
 * Does NOT call AI — it computes insights from data patterns.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db, profileSubcollection } from "../../firestore-client.js";
import { scrubDocument } from "../../scrubber.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { logToolCall, generateRequestId } from "../../logger.js";

export function registerGetCoachInsight(server: McpServer): void {
  server.tool(
    "get_coach_insight",
    "Get a contextual coaching insight based on the user's recent training activity, benchmarks, and goals. Returns data-driven observations about progress, consistency, and areas to focus on.",
    {},
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
        const [profileSnap, diarySnap, goalsSnap, benchmarksSnap] = await Promise.all([
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

        // 1. Training consistency (last 7 days)
        const now = new Date();
        const sevenDaysAgo = new Date(now);
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const sevenDaysAgoStr = sevenDaysAgo.toISOString().slice(0, 10);

        const recentCompleted = sessions.filter(
          (s) => (s.status === "completed" || s.is_completed) && s.scheduled_date >= sevenDaysAgoStr,
        );
        const recentPlanned = sessions.filter(
          (s) => s.scheduled_date >= sevenDaysAgoStr,
        );
        const targetPerWeek = profileData.preferences?.sessions_per_week || 4;

        if (recentCompleted.length >= targetPerWeek) {
          insights.push({
            type: "consistency",
            text: `${recentCompleted.length} sessions completed this week — hitting your target of ${targetPerWeek}. Consistency is building.`,
            confidence: "high",
            context: "weekly_completion",
          });
        } else if (recentPlanned.length > 0 && recentCompleted.length < targetPerWeek) {
          insights.push({
            type: "consistency",
            text: `${recentCompleted.length} of ${targetPerWeek} target sessions completed this week. ${targetPerWeek - recentCompleted.length} remaining to stay on track.`,
            confidence: "high",
            context: "weekly_completion",
          });
        }

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
                  text: `${bm.id} improved ${pctChange.toFixed(1)}% — from ${prevVal} to ${latestVal}. Progress is trending in the right direction.`,
                  confidence: "high",
                  context: "benchmark_improvement",
                });
              }
            }
          }
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

        const result = scrubDocument({
          insights: insights.slice(0, 3), // Cap at 3 most relevant
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
