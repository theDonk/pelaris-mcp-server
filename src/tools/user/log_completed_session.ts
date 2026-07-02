/**
 * MCP Tool: log_completed_session
 * Scope: training:write
 *
 * Logs a session as completed retroactively, with full exercise detail,
 * RPE, feedback tags, coach note, and date. Designed for AI coaching agents
 * to record sessions that have already happened.
 *
 * PEL-226. Migrated onto the coreToolsBridge (WS1, exercise naming plan,
 * 02/07/2026): the direct-Firestore body is deleted. This wrapper keeps
 * scope, rate-limit, request logging, and scrubbing; core `log_session`
 * owns completion semantics, idempotency (same date+sport+duration key
 * formula, so pre-migration entries still dedupe), exercise identity
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

const VALID_SPORTS = [
  "strength", "running", "swimming", "cycling", "triathlon",
  "crossfit", "general", "yoga", "mobility", "other",
] as const;

const VALID_FEEDBACK_TAGS = [
  "felt_strong", "felt_tired", "felt_energetic", "felt_sluggish",
  "good_form", "poor_form", "pain", "injury_flare",
] as const;

/** The legacy params this tool maps onto the core `log_session` contract.
 *  Mirrors the zod schema below; kept as an explicit interface so the
 *  mapping is unit-testable without an MCP server. */
export interface LogCompletedSessionParams {
  plannedSessionId?: string;
  date: string;
  sport: string;
  title?: string;
  sessionFocus?: string;
  durationMinutes?: number;
  rpe?: number;
  feedbackTags?: string[];
  feedbackNote?: string;
  exercises?: LegacyLoggedExerciseFields[];
  coachNote?: string;
}

/** Map the legacy tool params onto the core `log_session` input. Every
 *  legacy field is mapped explicitly (the server silently ignores unknown
 *  keys); exercise durationSec (seconds) converts to durationMinutes via
 *  the shared adapter. */
export function buildLogCompletedSessionCoreInput(
  params: LogCompletedSessionParams,
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    detailLevel: "detailed",
    sport: params.sport,
    date: params.date,
  };
  if (params.plannedSessionId !== undefined) input.plannedSessionId = params.plannedSessionId;
  if (params.title !== undefined) input.title = params.title;
  if (params.sessionFocus !== undefined) input.sessionFocus = params.sessionFocus;
  if (params.durationMinutes !== undefined) input.durationMinutes = params.durationMinutes;
  if (params.rpe !== undefined) input.rpe = params.rpe;
  if (params.feedbackTags !== undefined) input.feedbackTags = params.feedbackTags;
  if (params.feedbackNote !== undefined) input.feedbackNote = params.feedbackNote;
  if (params.coachNote !== undefined) input.coachNote = params.coachNote;
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
export function mapLogCompletedSessionResult(
  result: Record<string, unknown>,
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
      title: result.title,
      message: `Planned session "${result.title ?? result.sessionId}" marked as completed.`,
    };
  }
  return {
    sessionId: result.sessionId,
    status: "logged",
    date: result.date,
    sport: result.sport,
    title: result.title,
    duration: result.durationMinutes ?? null,
    rpe: result.rpe ?? null,
    exerciseCount: result.exerciseCount ?? 0,
    dataQuality: result.dataQuality,
    message: result.message,
  };
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
        .describe("If completing an existing planned session, provide its ID from the training context. Updates in-place instead of creating a duplicate."),
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

        // profileId comes ONLY from the validated claims, never from params.
        const bridged = await callCoreBridge(
          "log_session",
          claims.profile_id,
          buildLogCompletedSessionCoreInput(params),
        );

        const failure = bridgeFailureResponse(bridged, "logging completed session");
        if (failure) {
          logToolCall({
            requestId,
            tool: "log_completed_session",
            userPseudonym: claims.sub,
            latencyMs: Date.now() - start,
            success: false,
            error: bridged.error ?? "unknown error",
          });
          return failure;
        }

        const result = mapLogCompletedSessionResult(unwrapBridgeResult(bridged));

        logToolCall({
          requestId,
          tool: "log_completed_session",
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
