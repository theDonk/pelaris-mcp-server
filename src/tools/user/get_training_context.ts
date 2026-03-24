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
    "get_training_context",
    "Get a comprehensive training context snapshot for the authenticated user. Includes profile info, active program, recent sessions with RPE/completion, and latest check-in data.",
    {},
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

        // Extract profile context (minimal, no PII)
        const profileContext = {
          sport: profileData.intakeSummary?.primaryGoal || null,
          experienceLevel: profileData.training_context?.experience_level || null,
          equipment: profileData.training_context?.equipment || [],
          sessionsPerWeek: profileData.preferences?.sessions_per_week || null,
          preferredUnits: profileData.preferredUnits || "metric",
          hasInjuries: !!profileData.training_context?.injury_history,
        };

        // Active programs summary
        const programs = queuesSnap.docs.map((doc) => {
          const d = doc.data();
          const sessions = d.sessions || [];
          const completed = sessions.filter((s: Record<string, unknown>) => s.is_completed).length;
          return {
            queueId: doc.id,
            title: d.title,
            methodologyId: d.methodology_id,
            type: d.type,
            totalSessions: sessions.length,
            completedSessions: completed,
            currentWeek: sessions.length > 0
              ? Math.max(...sessions.map((s: Record<string, unknown>) => (s.week_number as number) || 1))
              : 1,
            generationStatus: d.generation_status || null,
          };
        });

        // Recent diary entries
        const recentSessions = diarySnap.docs.map((doc) => {
          const d = doc.data();
          return {
            sessionId: doc.id,
            title: d.title,
            scheduledDate: d.scheduled_date,
            status: d.status || (d.is_completed ? "completed" : "planned"),
            sessionType: d.session_type || null,
            sessionFocus: d.session_focus || null,
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
