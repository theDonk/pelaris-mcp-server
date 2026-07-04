/**
 * MCP Tool: log_workout
 * Scope: training:write
 *
 * Records a completed workout, either against a planned session or as a new
 * diary entry, with idempotency via a date+sport+duration hash.
 *
 * Migrated onto the coreToolsBridge (WS1, exercise naming plan, 02/07/2026):
 * the direct-Firestore body is deleted. This wrapper keeps scope, rate-limit,
 * request logging, and scrubbing; core `log_session` owns completion
 * semantics, idempotency (same key formula, so pre-migration entries still
 * dedupe), completedAsPrescribed target-to-actual copying, exercise identity
 * resolution, and planned-target resolution via session_target_resolver
 * (diary AND queue-resident sessions, retiring the diary-only ownership
 * path).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { checkWriteRateLimit } from "../../middleware/rate-limiter.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import { callCoreBridge } from "../shared/bridge_client.js";
import {
  EXERCISE_NAME_DESCRIPTION,
  type LegacyLoggedExerciseFields,
  bridgeFailureResponse,
  exerciseIdField,
  mapLegacyLoggedExercise,
  unwrapBridgeResult,
} from "../shared/core_adapter.js";

const VALID_SPORTS = ["strength", "running", "swimming", "cycling", "triathlon", "crossfit", "general", "yoga", "mobility", "other"] as const;
const VALID_FEELINGS = ["strong", "tired", "energetic", "sluggish", "motivated", "stressed", "recovered", "sore"] as const;

/** The legacy params this tool maps onto the core `log_session` contract.
 *  Mirrors the zod schema below; kept as an explicit interface so the
 *  mapping is unit-testable without an MCP server. */
export interface LogWorkoutParams {
  sessionId?: string;
  plannedSessionId?: string;
  completedAsPrescribed?: boolean;
  sport: string;
  duration: number;
  rpe: number;
  date?: string;
  exercises?: LegacyLoggedExerciseFields[];
  feelings?: string[];
  notes?: string;
}

/** Map the legacy tool params onto the core `log_session` input. Every
 *  legacy field is mapped explicitly (the server silently ignores unknown
 *  keys): top-level duration is already minutes (name change only), notes
 *  becomes feedbackNote, sessionId stays a plannedSessionId alias with the
 *  legacy priority, and exercise durationSec (seconds) converts to
 *  durationMinutes via the shared adapter. */
export function buildLogWorkoutCoreInput(params: LogWorkoutParams): Record<string, unknown> {
  const input: Record<string, unknown> = {
    detailLevel: "quick",
    sport: params.sport,
    durationMinutes: params.duration,
    rpe: params.rpe,
  };
  // Legacy priority: plannedSessionId wins over the sessionId alias.
  const plannedSessionId = params.plannedSessionId || params.sessionId;
  if (plannedSessionId) input.plannedSessionId = plannedSessionId;
  if (params.completedAsPrescribed !== undefined) input.completedAsPrescribed = params.completedAsPrescribed;
  if (params.date !== undefined) input.date = params.date;
  if (params.feelings !== undefined) input.feelings = params.feelings;
  if (params.notes !== undefined) input.feedbackNote = params.notes;
  if (params.exercises !== undefined) {
    input.exercises = params.exercises.map(mapLegacyLoggedExercise);
  }
  return input;
}

/** Map the core `log_session` output back onto this tool's legacy response
 *  shape (the status vocabulary and field names agents already parse).
 *  Core "updated" (a planned target was completed) -> "completed_planned";
 *  core "completed" (new diary entry, or an idempotency hit, which core
 *  reports in the message) -> "logged". */
export function mapLogWorkoutResult(
  result: Record<string, unknown>,
  completedAsPrescribed: boolean,
): Record<string, unknown> {
  if (result.status === "already_logged") {
    return {
      sessionId: result.sessionId,
      status: "already_logged",
      message: result.message,
    };
  }
  if (result.status === "updated") {
    return {
      sessionId: result.sessionId,
      status: "completed_planned",
      date: result.date,
      sport: result.sport,
      duration: result.durationMinutes ?? null,
      rpe: result.rpe ?? null,
      completedAsPrescribed,
      message: `Planned session "${result.sessionId}" marked as completed on ${result.date}.`,
    };
  }
  return {
    sessionId: result.sessionId,
    status: "logged",
    date: result.date,
    sport: result.sport,
    duration: result.durationMinutes ?? null,
    rpe: result.rpe ?? null,
    exerciseCount: result.exerciseCount ?? 0,
    dataQuality: result.dataQuality,
    message: result.message,
  };
}

export function registerLogWorkout(server: McpServer): void {
  server.registerTool(
    "log_workout",
    {
      title: "Log Workout",
      description: "Record a completed workout with exercises, RPE, and how you felt. Duplicate entries are automatically prevented.",
      inputSchema: {
        sessionId: z
          .string()
          .max(200)
          .optional()
          .describe("Existing diary session ID to update (if logging against a planned session)"),
        plannedSessionId: z
          .string()
          .optional()
          .describe("ID of a planned session to mark as completed. Found in training context."),
        completedAsPrescribed: z
          .boolean()
          .optional()
          .describe("If true, copies target values (sets/reps/weight) to actuals."),
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
              name: z.string().min(1).max(200).describe(EXERCISE_NAME_DESCRIPTION),
              exerciseId: exerciseIdField,
              sets: z.number().int().min(1).max(50).optional().describe("Number of sets completed"),
              reps: z.number().int().min(1).max(200).optional().describe("Reps per set"),
              weightKg: z.number().min(0).max(1000).optional().describe("Weight in kg"),
              durationSec: z.number().int().min(0).max(36000).optional().describe("Duration in seconds (for timed exercises)"),
              distanceMeters: z.number().min(0).max(100000).optional().describe("Distance in meters"),
              notes: z.string().max(500).optional().describe("Exercise-specific notes"),
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
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true, title: "Log Workout" },
    },
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

        // profileId comes ONLY from the validated claims, never from params.
        const bridged = await callCoreBridge(
          "log_session",
          claims.profile_id,
          buildLogWorkoutCoreInput(params),
        );

        const failure = bridgeFailureResponse(bridged, "logging workout");
        if (failure) {
          logToolCall({
            requestId,
            tool: "log_workout",
            userPseudonym: claims.sub,
            latencyMs: Date.now() - start,
            success: false,
            error: bridged.error ?? "unknown error",
          });
          return failure;
        }

        const result = mapLogWorkoutResult(
          unwrapBridgeResult(bridged),
          params.completedAsPrescribed || false,
        );

        logToolCall({
          requestId,
          tool: "log_workout",
          userPseudonym: claims.sub,
          latencyMs: Date.now() - start,
          success: true,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(scrubDocument(result), null, 2) }],
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
