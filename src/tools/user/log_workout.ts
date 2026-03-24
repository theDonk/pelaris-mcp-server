/**
 * MCP Tool: log_workout
 * Scope: training:write
 *
 * Creates or updates a diary entry for a completed workout.
 * Includes idempotency via date+sport+duration hash to prevent duplicate logs.
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

const VALID_SPORTS = ["strength", "running", "swimming", "cycling", "triathlon", "crossfit", "general", "yoga", "mobility", "other"] as const;
const VALID_FEELINGS = ["strong", "tired", "energetic", "sluggish", "motivated", "stressed", "recovered", "sore"] as const;

function generateIdempotencyKey(profileId: string, date: string, sport: string, duration: number): string {
  const raw = `${profileId}:${date}:${sport}:${duration}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export function registerLogWorkout(server: McpServer): void {
  server.tool(
    "log_workout",
    "Log a completed workout session. Creates a diary entry with exercise details, RPE, and feelings. Includes idempotency to prevent duplicate entries.",
    {
      sessionId: z
        .string()
        .max(200)
        .optional()
        .describe("Existing diary session ID to update (if logging against a planned session)"),
      sport: z
        .enum(VALID_SPORTS)
        .describe("Sport/activity type"),
      duration: z
        .number()
        .int()
        .min(1)
        .max(480)
        .describe("Workout duration in minutes (1-480)"),
      rpe: z
        .number()
        .min(1)
        .max(10)
        .describe("Rate of perceived exertion (1-10)"),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
        .optional()
        .describe("Workout date in YYYY-MM-DD format (defaults to today)"),
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
      feelings: z
        .array(z.enum(VALID_FEELINGS))
        .max(5)
        .optional()
        .describe("How you felt during the workout"),
      notes: z
        .string()
        .max(1000)
        .optional()
        .describe("Freeform notes about the session"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async (params) => {
      const requestId = generateRequestId();
      const start = Date.now();

      try {
        // Auth & scope check
        const claims = getRequestAuth();
        if (!claims || !hasScope(claims.scope, "training:write")) {
          return {
            content: [{ type: "text" as const, text: "Error: training:write scope required" }],
            isError: true,
          };
        }

        // Write rate limit
        const rateLimitError = checkWriteRateLimit(claims.sub);
        if (rateLimitError) {
          return {
            content: [{ type: "text" as const, text: `Error: ${rateLimitError}` }],
            isError: true,
          };
        }

        const profileId = claims.profile_id;
        const workoutDate = params.date || new Date().toISOString().split("T")[0];
        const diaryCol = profileSubcollection(profileId, "diary");

        // Idempotency check
        const idempotencyKey = generateIdempotencyKey(profileId, workoutDate, params.sport, params.duration);
        const existingByKey = await diaryCol
          .where("idempotency_key", "==", idempotencyKey)
          .limit(1)
          .get();

        if (!existingByKey.empty) {
          const existingDoc = existingByKey.docs[0];
          const result = scrubDocument({
            sessionId: existingDoc.id,
            status: "already_logged",
            message: "This workout has already been logged (matching date, sport, and duration). No duplicate created.",
          });
          logToolCall({
            requestId,
            tool: "log_workout",
            userPseudonym: claims.sub,
            latencyMs: Date.now() - start,
            success: true,
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        // Build exercise blocks if provided
        const blocks: Array<Record<string, unknown>> = [];
        if (params.exercises && params.exercises.length > 0) {
          blocks.push({
            type: "main",
            semantic_type: "working",
            exercises: params.exercises.map((ex) => {
              const exercise: Record<string, unknown> = {
                exercise_name: ex.name,
              };
              const sets: Array<Record<string, unknown>> = [];
              const setCount = ex.sets || 1;
              for (let i = 0; i < setCount; i++) {
                if (ex.weightKg != null || ex.reps != null) {
                  sets.push({
                    type: "strength",
                    actual_weight_kg: ex.weightKg ?? null,
                    actual_reps: ex.reps ?? null,
                    isCompleted: true,
                  });
                } else if (ex.distanceMeters != null || ex.durationSec != null) {
                  sets.push({
                    type: "cardio",
                    actual_distance_meters: ex.distanceMeters ?? null,
                    actual_duration_sec: ex.durationSec ?? null,
                    isCompleted: true,
                  });
                } else {
                  sets.push({
                    type: "general",
                    isCompleted: true,
                  });
                }
              }
              exercise.sets = sets;
              return exercise;
            }),
          });
        }

        // Build diary entry
        const timestamp = new Date().toISOString();
        const diaryEntry: Record<string, unknown> = {
          title: `${params.sport.charAt(0).toUpperCase() + params.sport.slice(1)} Session`,
          scheduled_date: workoutDate,
          session_type: params.sport,
          status: "completed",
          is_completed: true,
          completed_at: timestamp,
          duration_minutes: params.duration,
          blocks,
          feedback: {
            rpe: params.rpe,
            tags: params.feelings || [],
            note: params.notes || null,
          },
          data_quality: params.exercises && params.exercises.length > 0 ? "detailed" : "quick",
          source: "mcp",
          idempotency_key: idempotencyKey,
          created_at: timestamp,
          mcp_logged_at: timestamp,
        };

        let sessionId: string;

        if (params.sessionId) {
          // Update existing planned session
          const existingRef = diaryCol.doc(params.sessionId);
          const existingDoc = await existingRef.get();
          if (!existingDoc.exists) {
            return {
              content: [{ type: "text" as const, text: `Session "${params.sessionId}" not found` }],
              isError: true,
            };
          }
          await existingRef.update(diaryEntry);
          sessionId = params.sessionId;
        } else {
          // Create new diary entry
          const docRef = await diaryCol.add(diaryEntry);
          sessionId = docRef.id;
        }

        const result = scrubDocument({
          sessionId,
          status: "logged",
          date: workoutDate,
          sport: params.sport,
          duration: params.duration,
          rpe: params.rpe,
          exerciseCount: params.exercises?.length || 0,
          dataQuality: diaryEntry.data_quality,
          message: `Workout logged successfully: ${params.sport} session on ${workoutDate}`,
        });

        logToolCall({
          requestId,
          tool: "log_workout",
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
          tool: "log_workout",
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
