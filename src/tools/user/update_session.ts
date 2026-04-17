/**
 * MCP Tool: update_session
 * Scope: training:write
 *
 * Updates an existing diary session (planned or completed) with new or
 * corrected data. Supports: title, focus, duration, status change,
 * RPE, feedback, exercises, and coach notes.
 *
 * PEL-227
 */

import crypto from "crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { checkWriteRateLimit } from "../../middleware/rate-limiter.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import {
  verifySessionOwnership,
  OwnershipError,
  ownershipErrorResponse,
} from "../shared/ownership.js";

/** Generate a short random ID for blocks/exercises/sets. */
function shortId(): string {
  return crypto.randomBytes(8).toString("hex");
}

const VALID_STATUSES = ["planned", "completed"] as const;
const VALID_FEEDBACK_TAGS = [
  "felt_strong", "felt_tired", "felt_energetic", "felt_sluggish",
  "good_form", "poor_form", "pain", "injury_flare",
] as const;

export function registerUpdateSession(server: McpServer): void {
  server.tool(
    "update_session",
    "Update an existing session with corrected or additional data — title, focus, duration, status, RPE, feedback, exercises, or coach notes.",
    {
      sessionId: z
        .string()
        .min(1)
        .max(200)
        .describe("The diary session document ID to update"),
      title: z
        .string()
        .max(200)
        .optional()
        .describe("Updated session title"),
      sessionFocus: z
        .string()
        .max(200)
        .optional()
        .describe("Updated session focus area"),
      durationMinutes: z
        .number()
        .int()
        .min(1)
        .max(480)
        .optional()
        .describe("Updated duration in minutes"),
      status: z
        .enum(VALID_STATUSES)
        .optional()
        .describe("Change session status (e.g., mark planned as completed)"),
      scheduledDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
        .optional()
        .describe("Updated scheduled date in YYYY-MM-DD format"),
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
            sets: z.number().int().min(1).max(50).optional().describe("Number of sets"),
            reps: z.number().int().min(1).max(200).optional().describe("Reps per set"),
            weightKg: z.number().min(0).max(1000).optional().describe("Weight in kg"),
            durationSec: z.number().int().min(0).max(36000).optional().describe("Duration in seconds"),
            distanceMeters: z.number().min(0).max(100000).optional().describe("Distance in meters"),
          }),
        )
        .max(30)
        .optional()
        .describe("Replace session exercises (max 30). Overwrites existing blocks."),
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

        // H-03: defence-in-depth ownership check before per-tool guards.
        let diaryRef;
        let sessionData: Record<string, unknown>;
        let legacyOrigin = false;
        try {
          const result = await verifySessionOwnership(profileId, params.sessionId);
          diaryRef = result.doc.ref;
          sessionData = result.data;
          legacyOrigin = result.legacyOrigin;
        } catch (err) {
          if (err instanceof OwnershipError) {
            logToolCall({
              requestId,
              tool: "update_session",
              userPseudonym: claims.sub,
              latencyMs: Date.now() - start,
              success: false,
              error: `ownership.${err.code}`,
            });
            return ownershipErrorResponse(err);
          }
          throw err;
        }

        // Guard: Strava-imported sessions are read-only
        if (sessionData.strava_activity_id) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Cannot update a Strava-imported session" }) }],
            isError: true,
          };
        }

        // Validate at least one update field provided
        const hasUpdate = params.title || params.sessionFocus || params.durationMinutes ||
          params.status || params.scheduledDate || params.rpe != null ||
          params.feedbackTags || params.feedbackNote != null ||
          params.exercises || params.coachNote != null;

        if (!hasUpdate) {
          return {
            content: [{ type: "text" as const, text: "Error: At least one field to update is required" }],
            isError: true,
          };
        }

        const updates: Record<string, unknown> = {};
        const updatedFields: string[] = [];
        const timestamp = new Date().toISOString();

        // Basic fields
        if (params.title) {
          updates.title = params.title;
          updatedFields.push("title");
        }
        if (params.sessionFocus) {
          updates.session_focus = params.sessionFocus;
          updatedFields.push("sessionFocus");
        }
        if (params.durationMinutes) {
          updates.duration_minutes = params.durationMinutes;
          updatedFields.push("durationMinutes");
        }
        if (params.scheduledDate) {
          updates.scheduled_date = params.scheduledDate;
          updatedFields.push("scheduledDate");
        }

        // Status change — handle planned→completed transition
        if (params.status) {
          updates.status = params.status;
          updatedFields.push("status");

          if (params.status === "completed" && sessionData.status !== "completed") {
            updates.is_completed = true;
            updates.completed_at = timestamp;
          } else if (params.status === "planned") {
            updates.is_completed = false;
            updates.completed_at = null;
          }
        }

        // Feedback fields — use dot notation for nested updates
        if (params.rpe != null) {
          updates["feedback.rpe"] = params.rpe;
          updatedFields.push("rpe");
        }
        if (params.feedbackTags) {
          updates["feedback.tags"] = params.feedbackTags;
          updatedFields.push("feedbackTags");
        }
        if (params.feedbackNote != null) {
          updates["feedback.note"] = params.feedbackNote;
          updatedFields.push("feedbackNote");
        }

        // Coach note — structured object matching CoachNotePayload.fromMap()
        if (params.coachNote != null) {
          updates.coach_note = {
            title: "Coach Note",
            message: params.coachNote,
            source: "mcp",
            created_at: timestamp,
          };
          updatedFields.push("coachNote");
        }

        // Determine effective completion state (prioritize in-flight status change)
        const effectiveStatus = params.status || sessionData.status;
        const effectivelyCompleted = effectiveStatus === "completed" &&
          params.status !== "planned";

        // W2 fix: If marking planned→completed without new exercises, copy target→actual on existing blocks
        if (params.status === "completed" && sessionData.status !== "completed" &&
            (!params.exercises || params.exercises.length === 0)) {
          const existingBlocks = sessionData.blocks as Array<Record<string, unknown>> | undefined;
          if (existingBlocks && existingBlocks.length > 0) {
            updates.blocks = existingBlocks.map((block) => {
              const exercises = block.exercises as Array<Record<string, unknown>> | undefined;
              if (!exercises) return block;
              return {
                ...block,
                exercises: exercises.map((exercise) => {
                  const sets = exercise.sets as Array<Record<string, unknown>> | undefined;
                  if (!sets) return exercise;
                  return {
                    ...exercise,
                    sets: sets.map((set) => ({
                      ...set,
                      isCompleted: true,
                      ...(set.target_weight_kg != null && { actual_weight_kg: set.target_weight_kg }),
                      ...(set.target_reps != null && { actual_reps: set.target_reps }),
                      ...(set.target_distance_meters != null && { actual_distance_meters: set.target_distance_meters }),
                      ...(set.target_duration_sec != null && { actual_duration_sec: set.target_duration_sec }),
                    })),
                  };
                }),
              };
            });
          }
        }

        // Exercise replacement — builds fresh blocks from provided exercises
        if (params.exercises && params.exercises.length > 0) {
          const blocks: Array<Record<string, unknown>> = [{
            id: shortId(),
            type: "single",
            rounds: 1,
            semantic_type: "working",
            exercises: params.exercises.map((ex) => {
              const sets: Array<Record<string, unknown>> = [];
              const setCount = ex.sets || 1;
              const isCompleted = effectivelyCompleted;

              for (let i = 0; i < setCount; i++) {
                if (ex.weightKg != null || ex.reps != null) {
                  const set: Record<string, unknown> = { id: shortId(), type: "strength" };
                  if (isCompleted) {
                    set.actual_weight_kg = ex.weightKg ?? null;
                    set.actual_reps = ex.reps ?? null;
                    set.isCompleted = true;
                  } else {
                    set.target_weight_kg = ex.weightKg ?? null;
                    set.target_reps = ex.reps ?? null;
                  }
                  sets.push(set);
                } else if (ex.distanceMeters != null || ex.durationSec != null) {
                  const set: Record<string, unknown> = { id: shortId(), type: "cardio" };
                  if (isCompleted) {
                    set.actual_distance_meters = ex.distanceMeters ?? null;
                    set.actual_duration_sec = ex.durationSec ?? null;
                    set.isCompleted = true;
                  } else {
                    set.target_distance_meters = ex.distanceMeters ?? null;
                    set.target_duration_sec = ex.durationSec ?? null;
                  }
                  sets.push(set);
                } else {
                  sets.push({
                    id: shortId(),
                    type: "general",
                    ...(isCompleted ? { isCompleted: true } : {}),
                  });
                }
              }
              return { exercise_id: shortId(), exercise_name: ex.name, sets };
            }),
          }];
          updates.blocks = blocks;
          updatedFields.push("exercises");
        }

        // Metadata
        updates.updated_at = timestamp;
        updates.mcp_updated_at = timestamp;

        await diaryRef.update(updates);

        const result = scrubDocument({
          sessionId: params.sessionId,
          title: params.title || sessionData.title,
          status: params.status || sessionData.status,
          updatedFields,
          message: `Session updated: ${updatedFields.join(", ")}`,
        });

        logToolCall({
          requestId,
          tool: "update_session",
          userPseudonym: claims.sub,
          latencyMs: Date.now() - start,
          success: true,
          extras: legacyOrigin ? { legacy_origin: true } : undefined,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        logToolCall({
          requestId,
          tool: "update_session",
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
