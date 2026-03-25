/**
 * MCP Tool: create_planned_session
 * Scope: training:write
 *
 * Creates a planned diary entry for a future workout session.
 * The session appears in the Pelaris app's Train tab on the scheduled date,
 * with target exercises that the user can then track actuals against.
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
  "strength", "running", "swimming", "cycling",
  "triathlon", "crossfit", "other",
] as const;

/** Map MCP sport names to the session_type values the Pelaris app expects. */
function mapSportToSessionType(sport: string): string {
  switch (sport) {
    case "running": return "run";
    case "swimming": return "swim";
    case "cycling": return "ride";
    case "crossfit": return "hiit";
    default: return sport; // strength, triathlon, other → pass through
  }
}

/** Generate a short random ID for blocks/exercises/sets. */
function shortId(): string {
  return crypto.randomBytes(8).toString("hex");
}

export function registerCreatePlannedSession(server: McpServer): void {
  server.tool(
    "Create Planned Session",
    "Schedule a future workout session with target exercises. The session will appear in your training calendar ready to track.",
    {
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
        .describe("Scheduled date for the session (YYYY-MM-DD)"),
      sport: z
        .enum(VALID_SPORTS)
        .describe("Sport/activity type"),
      title: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Session title (defaults to '{Sport} Session')"),
      durationMinutes: z
        .number()
        .int()
        .min(1)
        .max(480)
        .optional()
        .describe("Estimated duration in minutes (1-480)"),
      sessionFocus: z
        .string()
        .max(200)
        .optional()
        .describe("Focus description, e.g. 'Upper Body Strength', 'Threshold Intervals'"),
      coachNote: z
        .string()
        .max(1000)
        .optional()
        .describe("Coaching context explaining why this session matters"),
      exercises: z
        .array(
          z.object({
            name: z.string().min(1).max(200).describe("Exercise name"),
            sets: z.number().int().min(1).max(50).optional().describe("Number of sets"),
            reps: z.number().int().min(1).max(200).optional().describe("Target reps per set"),
            weight: z.number().min(0).max(1000).optional().describe("Target weight in kg"),
            duration: z.number().int().min(0).max(36000).optional().describe("Duration in seconds (for cardio/timed exercises)"),
            distance: z.number().min(0).max(100000).optional().describe("Distance in meters"),
            notes: z.string().max(500).optional().describe("Exercise-specific notes"),
          }),
        )
        .max(30)
        .optional()
        .describe("Array of planned exercises (max 30)"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
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
        const sessionType = mapSportToSessionType(params.sport);
        const sessionTitle =
          params.title ||
          `${params.sport.charAt(0).toUpperCase() + params.sport.slice(1)} Session`;

        const diaryCol = profileSubcollection(profileId, "diary");

        // Build exercise blocks with TARGET fields (not actuals)
        const blocks: Array<Record<string, unknown>> = [];
        if (params.exercises && params.exercises.length > 0) {
          blocks.push({
            id: shortId(),
            type: "single",
            semantic_type: "main",
            rounds: 1,
            exercises: params.exercises.map((ex) => {
              const setCount = ex.sets || 1;
              const sets: Array<Record<string, unknown>> = [];

              for (let i = 0; i < setCount; i++) {
                if (ex.weight != null || ex.reps != null) {
                  // Strength set — use target fields
                  sets.push({
                    id: shortId(),
                    type: "strength",
                    target_weight_kg: ex.weight ?? null,
                    target_reps: ex.reps ?? null,
                    isCompleted: false,
                    notes: ex.notes ?? null,
                  });
                } else if (ex.distance != null || ex.duration != null) {
                  // Cardio set — use target fields
                  sets.push({
                    id: shortId(),
                    type: "cardio",
                    target_distance_meters: ex.distance ?? null,
                    target_duration_sec: ex.duration ?? null,
                    isCompleted: false,
                    notes: ex.notes ?? null,
                  });
                } else {
                  // General set (e.g. bodyweight exercise with just a name)
                  sets.push({
                    id: shortId(),
                    type: "strength",
                    target_reps: ex.reps ?? null,
                    isCompleted: false,
                    notes: ex.notes ?? null,
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

        // Build diary entry — planned session
        const timestamp = new Date().toISOString();
        const diaryEntry: Record<string, unknown> = {
          title: sessionTitle,
          scheduled_date: params.date,
          session_type: sessionType,
          status: "planned",
          is_completed: false,
          blocks,
          source: "mcp",
          created_at: timestamp,
          updated_at: timestamp,
        };

        // Optional fields — only include if provided
        if (params.durationMinutes != null) {
          diaryEntry.duration_minutes = params.durationMinutes;
        }
        if (params.sessionFocus) {
          diaryEntry.session_focus = params.sessionFocus;
        }
        if (params.coachNote) {
          diaryEntry.coach_note = {
            text: params.coachNote,
            source: "mcp",
            created_at: timestamp,
          };
        }

        // Write to Firestore
        const docRef = await diaryCol.add(diaryEntry);
        const sessionId = docRef.id;

        const result = scrubDocument({
          sessionId,
          status: "created",
          date: params.date,
          title: sessionTitle,
          sport: params.sport,
          sessionType,
          exerciseCount: params.exercises?.length || 0,
          message: `Planned session created: "${sessionTitle}" on ${params.date}. It will appear in the Train tab for tracking.`,
        });

        logToolCall({
          requestId,
          tool: "create_planned_session",
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
          tool: "create_planned_session",
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
