/**
 * MCP Tool: get_training_context
 * Scope: training:read
 *
 * Returns a comprehensive training context snapshot including:
 * profile, active program, recent diary sessions, check-in data.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, profileSubcollection } from "../../firestore-client.js";
import { scrubDocument } from "../../scrubber.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { logToolCall, generateRequestId } from "../../logger.js";

export function registerGetTrainingContext(server: McpServer): void {
  server.tool(
    "get_training_overview",
    "View your complete training snapshot — active programs, recent sessions, check-in data, goals, and progress at a glance.",
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

        // Parallel reads for performance
        const [profileSnap, queuesSnap, diarySnap, checkinsSnap, goalsSnap] = await Promise.all([
          db.collection("profiles").doc(profileId).get(),
          profileSubcollection(profileId, "queues")
            .where("generation_status", "in", ["complete", null])
            .orderBy("date_created", "desc")
            .limit(3)
            .get()
            .catch(() =>
              // Fallback if index doesn't support the compound query
              profileSubcollection(profileId, "queues")
                .orderBy("date_created", "desc")
                .limit(3)
                .get()
            ),
          profileSubcollection(profileId, "diary")
            .orderBy("scheduled_date", "desc")
            .limit(14)
            .get(),
          profileSubcollection(profileId, "checkins")
            .orderBy("created_at", "desc")
            .limit(3)
            .get(),
          profileSubcollection(profileId, "goals")
            .where("is_completed", "==", false)
            .limit(10)
            .get(),
        ]);

        if (!profileSnap.exists) {
          return {
            content: [{ type: "text" as const, text: "Profile not found" }],
            isError: true,
          };
        }

        const profileData = profileSnap.data() || {};

        // PEL-220: Use profile.active_queues to determine truly active programs
        const activeQueueIds = new Set(
          ((profileData.active_queues || []) as Array<Record<string, unknown>>)
            .filter((q) => q.is_active === true)
            .map((q) => q.queue_id as string),
        );
        const activeDocs = queuesSnap.docs.filter((doc) => activeQueueIds.has(doc.id));
        const programs = activeDocs.map((doc) => {
          const d = doc.data();
          const sessions = d.sessions || [];
          const completed = sessions.filter((s: Record<string, unknown>) => s.is_completed).length;
          return {
            queueId: doc.id,
            title: d.title,
            methodologyId: d.methodology_id,
            sport: d.sport || null,
            type: d.type,
            totalSessions: sessions.length,
            completedSessions: completed,
            currentWeek: sessions.length > 0
              ? Math.max(...sessions.map((s: Record<string, unknown>) => (s.week_number as number) || 1))
              : 1,
            generationStatus: d.generation_status || null,
          };
        });

        // Extract profile context (minimal, no PII)
        // Try multiple field paths for sport (different profile formats exist)
        let sport: string | null =
          profileData.sport ||
          profileData.intakeSummary?.primarySport ||
          profileData.intakeSummary?.primaryGoal ||
          null;
        if (!sport && programs.length > 0) {
          sport = programs[0].sport || programs[0].methodologyId?.split("_")[0] || null;
        }

        const profileContext = {
          sport,
          experienceLevel: profileData.training_context?.experience_level || profileData.experience || null,
          equipment: profileData.training_context?.equipment || profileData.equipment || [],
          sessionsPerWeek: profileData.preferences?.sessions_per_week || profileData.availability?.days_per_week || null,
          preferredUnits: profileData.preferredUnits || profileData.preferred_units || "metric",
          hasInjuries: !!profileData.training_context?.injury_history,
        };

        // Recent diary entries
        const recentSessions = diarySnap.docs.map((doc) => {
          const d = doc.data();
          // session_type may be absent on older diary docs — fall back to
          // sessionType (camelCase variant) then infer from title keywords
          let sessionType: string | null = d.session_type || d.sessionType || null;
          if (!sessionType && d.title) {
            const titleLower = (d.title as string).toLowerCase();
            if (titleLower.includes("swim")) sessionType = "swim";
            else if (titleLower.includes("run")) sessionType = "run";
            else if (titleLower.includes("ride") || titleLower.includes("cycl")) sessionType = "ride";
            else if (titleLower.includes("strength") || titleLower.includes("lift")) sessionType = "strength";
            else if (titleLower.includes("mobility") || titleLower.includes("yoga")) sessionType = "mobility";
            else if (titleLower.includes("hiit")) sessionType = "hiit";
          }
          return {
            sessionId: doc.id,
            title: d.title,
            scheduledDate: d.scheduled_date,
            status: d.status || (d.is_completed ? "completed" : "planned"),
            sessionType,
            sessionFocus: d.session_focus || d.sessionFocus || null,
            rpe: d.feedback?.rpe || null,
            feedbackTags: d.feedback?.tags || [],
            dataQuality: d.data_quality || null,
            blockCount: (d.blocks || []).length,
          };
        });

        // Check-ins
        const checkins = checkinsSnap.docs.map((doc) => {
          const d = doc.data();
          return {
            type: d.type,
            rawText: d.raw_text,
            periodStart: d.period_start?.toDate?.()?.toISOString?.() || null,
            periodEnd: d.period_end?.toDate?.()?.toISOString?.() || null,
          };
        });

        // Goals
        const goals = goalsSnap.docs.map((doc) => {
          const d = doc.data();
          return {
            description: d.description,
            targetDate: d.target_date || null,
            source: d.source || null,
          };
        });

        const result = scrubDocument({
          profile: profileContext,
          activePrograms: programs,
          recentSessions,
          checkins,
          goals,
          goalSummary: profileData.goal_summary?.text || null,
          benchmarkSummary: profileData.benchmark_summary?.text || null,
        } as Record<string, unknown>);

        logToolCall({
          requestId,
          tool: "get_training_context",
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
          tool: "get_training_context",
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
