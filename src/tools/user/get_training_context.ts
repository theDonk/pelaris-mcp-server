/**
 * MCP Tool: get_training_context
 * Scope: training:read
 *
 * Returns a comprehensive training context snapshot including:
 * profile, active program, recent diary sessions, check-in data.
 *
 * 1.4.1 D2 (connector truth): each program's week, phase and completion, and
 * the week's counts, come from the app's backend (`get_training_truth` over the
 * coreToolsBridge), the same answer the app shows. The "current week" here used to be
 * the highest built week, so a program in week 9 of 24 read as week 12. Existing output
 * fields keep their names; plain-language fields are added.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, profileSubcollection } from "../../firestore-client.js";
import { scrubDocument } from "../../scrubber.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import { programTruthFields, readTrainingTruth, type TruthReader } from "../shared/training_truth.js";

/** An injury id as the core issues it. */
const INJURY_ID = /^inj_[0-9a-f]{10}$/;
const BODY_PART_TOKEN = /^[a-z_]{1,24}$/;

/**
 * Active injury entries that carry a stored `injury_id`, as closed values
 * (id, body part, side, severity): the ids a connector needs for
 * record_injury's update and resolve. Entries written before ids existed have
 * none and are not listed (the in-app coach can still reach them). Never a note.
 */
export function activeInjuriesWithIds(entries: unknown): Array<{ injuryId: string; bodyPart: string; side: string | null; severity: string | null }> {
  if (!Array.isArray(entries)) return [];
  const out: Array<{ injuryId: string; bodyPart: string; side: string | null; severity: string | null }> = [];
  for (const raw of entries) {
    if (raw == null || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (e.is_active === false || typeof e.injury_id !== "string" || !INJURY_ID.test(e.injury_id)) continue;
    const side = e.side;
    const severity = e.severity;
    out.push({
      injuryId: e.injury_id,
      bodyPart: typeof e.body_part === "string" && BODY_PART_TOKEN.test(e.body_part) ? e.body_part : "general",
      side: typeof side === "string" && ["left", "right", "both", "bilateral", "n/a"].includes(side) ? side : null,
      severity: typeof severity === "string" && ["mild", "moderate", "severe"].includes(severity) ? severity : null,
    });
  }
  return out;
}

/** The program truth this tool reads, injectable for tests. */
export interface TrainingContextDeps {
  truth: TruthReader;
}

export function registerGetTrainingContext(
  server: McpServer,
  deps: TrainingContextDeps = { truth: readTrainingTruth },
): void {
  server.registerTool(
    "get_training_overview",
    {
      title: "Get Training Overview",
      description: "View your complete training snapshot — active programs, recent sessions, check-in data, goals, and progress at a glance.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, title: "Get Training Overview" },
    },
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
        const [truth, profileSnap, queuesSnap, diarySnap, checkinsSnap, goalsSnap] = await Promise.all([
          deps.truth(profileId),
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

        // Use profile.active_queues to determine truly active programs (the truth reads the same list)
        const activeQueueIds = new Set(
          ((profileData.active_queues || []) as Array<Record<string, unknown>>)
            .filter((q) => q.is_active === true)
            .map((q) => q.queue_id as string),
        );
        const queueById = new Map(queuesSnap.docs.map((doc) => [doc.id, doc.data()]));
        // The week, phase and completion are the app's (truth). If the backend could not answer, say so
        // rather than guess a week: the rest of the snapshot is still true.
        const programs = (truth?.programs ?? []).map((p) => {
          const d = queueById.get(p.queueId) ?? {};
          return {
            programId: p.queueId,
            title: p.title,
            sport: d.sport || null,
            type: d.type ?? null,
            totalSessions: p.completion.sessionsTotal,
            completedSessions: p.completion.sessionsCompleted,
            currentWeek: p.currentWeek,
            currentPhase: p.phase ? { phase: p.phase.phase, focus: p.phase.focus } : null,
            generationStatus: p.generationStatus,
            ...programTruthFields(p),
          };
        });
        const activeDocs = queuesSnap.docs.filter((doc) => activeQueueIds.has(doc.id));

        // Extract profile context (minimal, no PII)
        // Try multiple field paths for sport (different profile formats exist)
        let sport: string | null =
          profileData.sport ||
          profileData.intakeSummary?.primarySport ||
          profileData.intakeSummary?.primaryGoal ||
          null;
        if (!sport && programs.length > 0) {
          // methodology_id is internal and no longer returned to the client, so
          // read it from the raw first active doc for sport inference only.
          const firstMethodologyId = activeDocs[0]?.data()?.methodology_id as string | undefined;
          sport = programs[0].sport || firstMethodologyId?.split("_")[0] || null;
        }

        const profileContext = {
          sport,
          experienceLevel: profileData.training_context?.experience_level || profileData.experience || null,
          equipment: profileData.training_context?.equipment || profileData.equipment || [],
          sessionsPerWeek: profileData.preferences?.sessions_per_week || profileData.availability?.days_per_week || null,
          preferredUnits: profileData.preferredUnits || profileData.preferred_units || "metric",
          hasInjuries: !!profileData.training_context?.injury_history,
          // 1.4 B2c (IJ-3b): the active injuries that carry an id, as closed values, so a
          // connector can update or resolve one with record_injury. No notes.
          activeInjuries: activeInjuriesWithIds(profileData.training_context?.injuries),
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
          ...(truth == null
            ? {
                programsNote:
                  "Your program details could not be read just now, so this list may be incomplete. This does not mean " +
                  "you have no program: do not offer to create a new one. Try again in a moment.",
              }
            : {
                primaryProgramId: truth.primaryQueueId,
                thisWeek: truth.weekCounts == null
                  ? null
                  : {
                      weekStarting: truth.week.weekId,
                      weekEnding: truth.week.weekEndId,
                      ...truth.weekCounts,
                      note: "Counts for the calendar week, Monday to Sunday. Program sessions are counted against the plan; bonus sessions are extra and never a shortfall.",
                    },
                asOf: truth.asOf,
              }),
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
