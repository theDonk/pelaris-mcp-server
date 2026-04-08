/**
 * MCP Tool: log_completed_session
 * Scope: training:write
 *
 * Logs a session as completed retroactively — with full exercise detail,
 * RPE, feedback tags, coach note, and date. Designed for AI coaching agents
 * to record sessions that have already happened.
 *
 * PEL-226
 */

import crypto from "crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { profileSubcollection } from "../../firestore-client.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { checkWriteRateLimit } from "../../middleware/rate-limiter.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";

const VALID_SPORTS = [
  "strength", "running", "swimming", "cycling", "triathlon",
  "crossfit", "general", "yoga", "mobility", "other",
] as const;

const VALID_FEEDBACK_TAGS = [
  "felt_strong", "felt_tired", "felt_energetic", "felt_sluggish",
  "good_form", "poor_form", "pain", "injury_flare",
] as const;

/** Map MCP sport names to the session_type values the Pelaris app expects. */
function mapSportToSessionType(sport: string): string {
  switch (sport) {
    case "running": return "run";
    case "swimming": return "swim";
    case "cycling": return "ride";
    case "crossfit": return "hiit";
    default: return sport;
  }
}

/** Generate a short random ID for blocks/exercises/sets. */
function shortId(): string {
  return crypto.randomBytes(8).toString("hex");
}

function generateIdempotencyKey(profileId: string, date: string, sport: string, duration: number): string {
  const raw = `${profileId}:${date}:${sport}:${duration}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export function registerLogCompletedSession(server: McpServer): void {
  server.tool(
    "log_completed_session",
    "Log a completed workout retroactively with exercises, RPE, feedback, and coach notes. Prevents duplicate entries automatically.",
    {
      plannedSessionId: z
        .string()
        .max(200)
        .optional()
        .describe("If completing an existing planned session, provide its diary ID. Updates in-place instead of creating a duplicate."),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
        .describe("Date the workout was completed (YYYY-MM-DD, can be in the past)"),
      sport: z
        .enum(VALID_SPORTS)
        .describe("Sport/activity type"),
      title: z
        .string()
        .max(200)
        .optional()
        .describe("Session title (e.g., 'Upper Body Strength', 'Easy Recovery Run')"),
      sessionFocus: z
        .string()
        .max(200)
        .optional()
        .describe("Session focus area (e.g., 'chest and shoulders', 'tempo intervals')"),
      durationMinutes: z
        .number()
        .int()
        .min(1)
        .max(480)
        .optional()
        .describe("Workout duration in minutes (1-480)"),
      rpe: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("Rate of perceived exertion (1-10)"),
      feedbackTags: z
        .array(z.enum(VALID_FEEDBACK_TAGS))
        .max(5)
        .optional()
        .describe("Feedback tags describing how the session went"),
      feedbackNote: z
        .string()
        .max(1000)
        .optional()
        .describe("Freeform notes about the session"),
      exercises: z
        .array(
          z.object({
            name: z.string().min(1).max(200).describe("Exercise name"),
            sets: z.number().int().min(1).max(50).optional().describe("Number of sets completed"),
            reps: z.number().int().min(1).max(200).optional().describe("Reps per set"),
            weightKg: z.number().min(0).max(1000).optional().describe("Weight in kg"),
            durationSec: z.number().int().min(0).max(36000).optional().describe("Duration in seconds (for timed exercises)"),
            distanceMeters: z.number().min(0).max(100000).optional().describe("Distance in meters"),
          }),
        )
        .max(30)
        .optional()
        .describe("Array of exercises performed (max 30)"),
      coachNote: z
        .string()
        .max(2000)
        .optional()
        .describe("AI coach observation or note about this session"),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    async (params) => {
      const requestId = generateRequestId();
      const start = Date.now();

      try {
        const claims = getRequestAuth();
        if (!claims || !hasScope(claims.scope, "training:write")) {
          return {
            content: [{ type: "text" as const, text: "Error: training:write scope required" }],
            isError: true,
          };
        }

        const rateLimitError = checkWriteRateLimit(claims.sub);
        if (rateLimitError) {
          return {
            content: [{ type: "text" as const, text: `Error: ${rateLimitError}` }],
            isError: true,
          };
        }

        const profileId = claims.profile_id;
        const diaryCol = profileSubcollection(profileId, "diary");
        const duration = params.durationMinutes || 0;

        // Idempotency: date + sport + duration hash
        const idempotencyKey = generateIdempotencyKey(profileId, params.date, params.sport, duration);
        const existingByKey = await diaryCol
          .where("idempotency_key", "==", idempotencyKey)
          .limit(1)
          .get();

        if (!existingByKey.empty) {
          const existingDoc = existingByKey.docs[0];
          const result = scrubDocument({
            sessionId: existingDoc.id,
            status: "already_logged",
            message: "This session has already been logged (matching date, sport, and duration). No duplicate created.",
          });
          logToolCall({
            requestId,
            tool: "log_completed_session",
            userPseudonym: claims.sub,
            latencyMs: Date.now() - start,
            success: true,
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        // Build exercise blocks
        const blocks: Array<Record<string, unknown>> = [];
        if (params.exercises && params.exercises.length > 0) {
          blocks.push({
            id: shortId(),
            type: "single",
            rounds: 1,
            semantic_type: "working",
            exercises: params.exercises.map((ex) => {
              const sets: Array<Record<string, unknown>> = [];
              const setCount = ex.sets || 1;
              for (let i = 0; i < setCount; i++) {
                if (ex.weightKg != null || ex.reps != null) {
                  sets.push({
                    id: shortId(),
                    type: "strength",
                    actual_weight_kg: ex.weightKg ?? null,
                    actual_reps: ex.reps ?? null,
                    isCompleted: true,
                  });
                } else if (ex.distanceMeters != null || ex.durationSec != null) {
                  sets.push({
                    id: shortId(),
                    type: "cardio",
                    actual_distance_meters: ex.distanceMeters ?? null,
                    actual_duration_sec: ex.durationSec ?? null,
                    isCompleted: true,
                  });
                } else {
                  sets.push({
                    id: shortId(),
                    type: "general",
                    isCompleted: true,
                  });
                }
              }
              return {
                exercise_id: shortId(),
                exercise_name: ex.name,
                sets,
              };
            }),
          });
        }

        const timestamp = new Date().toISOString();

        // --- Planned session completion path ---
        if (params.plannedSessionId) {
          const plannedRef = diaryCol.doc(params.plannedSessionId);
          const plannedSnap = await plannedRef.get();
          if (!plannedSnap.exists) {
            return {
              content: [{ type: "text" as const, text: `Error: Planned session "${params.plannedSessionId}" not found in diary.` }],
              isError: true,
            };
          }

          const plannedData = plannedSnap.data()!;
          if (plannedData.status === "completed" || plannedData.is_completed === true) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ sessionId: params.plannedSessionId, status: "already_completed", message: "This session is already completed." }) }],
            };
          }

          const updateData: Record<string, unknown> = {
            status: "completed",
            is_completed: true,
            completed_at: timestamp,
            source: "mcp",
            updated_at: timestamp,
          };

          if (params.title) updateData.title = params.title;
          if (params.sessionFocus) updateData.session_focus = params.sessionFocus;
          if (params.durationMinutes) updateData.duration_minutes = params.durationMinutes;
          if (params.rpe != null) updateData["feedback.rpe"] = params.rpe;
          if (params.feedbackTags && params.feedbackTags.length > 0) updateData["feedback.tags"] = params.feedbackTags;
          if (params.feedbackNote != null) updateData["feedback.note"] = params.feedbackNote;
          if (params.coachNote != null) updateData.coach_note = {
            title: "Coach Note",
            message: params.coachNote,
            source: "mcp",
            created_at: timestamp,
          };
          if (blocks.length > 0) updateData.blocks = blocks;

          await plannedRef.update(updateData);

          const result = scrubDocument({
            sessionId: params.plannedSessionId,
            status: "completed_planned",
            date: params.date,
            sport: params.sport,
            title: params.title || plannedData.title,
            message: `Planned session "${plannedData.title || params.plannedSessionId}" marked as completed.`,
          });

          logToolCall({
            requestId,
            tool: "log_completed_session",
            userPseudonym: claims.sub,
            latencyMs: Date.now() - start,
            success: true,
          });

          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        // --- New diary entry path (no planned session) ---
        const defaultTitle = `${params.sport.charAt(0).toUpperCase() + params.sport.slice(1)} Session`;

        const diaryEntry: Record<string, unknown> = {
          title: params.title || defaultTitle,
          scheduled_date: params.date,
          session_type: mapSportToSessionType(params.sport),
          session_focus: params.sessionFocus || null,
          status: "completed",
          is_completed: true,
          completed_at: timestamp,
          updated_at: timestamp,
          duration_minutes: duration || null,
          blocks,
          feedback: {
            rpe: params.rpe ?? null,
            tags: params.feedbackTags || [],
            note: params.feedbackNote || null,
          },
          coach_note: params.coachNote ? {
            title: "Coach Note",
            message: params.coachNote,
            source: "mcp",
            created_at: timestamp,
          } : null,
          data_quality: params.exercises && params.exercises.length > 0 ? "detailed" : "quick",
          source: "mcp",
          idempotency_key: idempotencyKey,
          created_at: timestamp,
          mcp_logged_at: timestamp,
        };

        const docRef = await diaryCol.add(diaryEntry);
        const sessionId = docRef.id;
        await docRef.update({ id: sessionId });

        const result = scrubDocument({
          sessionId,
          status: "logged",
          date: params.date,
          sport: params.sport,
          title: diaryEntry.title,
          duration: duration || null,
          rpe: params.rpe ?? null,
          exerciseCount: params.exercises?.length || 0,
          dataQuality: diaryEntry.data_quality,
          message: `Completed session logged: "${diaryEntry.title}" on ${params.date}.`,
        });

        logToolCall({
          requestId,
          tool: "log_completed_session",
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
          tool: "log_completed_session",
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
