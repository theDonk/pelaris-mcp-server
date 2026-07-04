/**
 * MCP Tool: update_session
 * Scope: training:write
 *
 * Updates an existing session (planned or completed) with new or corrected
 * data. Supports: title, focus, duration, status change, RPE, feedback,
 * exercises, structured blocks, and coach notes.
 *
 * Migrated onto the coreToolsBridge (WS1.1/WS1.3, exercise naming plan
 * 02/07/2026): the direct Firestore body is gone. Core modify_session
 * handles metadata edits (with write-time exercise identity resolution and
 * queue-session targets via the session_target_resolver), and core
 * log_session handles the completed transition (target -> actual copy, or
 * actual sets when exercises are provided). This wrapper keeps auth, scope,
 * rate-limit, logging, and scrubbing only.
 *
 * PEL-227
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { checkWriteRateLimit } from "../../middleware/rate-limiter.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import { callCoreBridge, type BridgeResult } from "../shared/bridge_client.js";
import {
  EXERCISE_NAME_DESCRIPTION,
  bridgeFailureResponse,
  coreWriteBlocksField,
  exerciseIdField,
  unwrapBridgeResult,
} from "../shared/core_adapter.js";
import {
  buildUpdateSessionCompletionInput,
  buildUpdateSessionMetadataInput,
  isCompletionRequest,
  listProvidedUpdateFields,
} from "./session_modify_mapping.js";

const VALID_STATUSES = ["planned", "completed"] as const;
const VALID_FEEDBACK_TAGS = [
  "felt_strong", "felt_tired", "felt_energetic", "felt_sluggish",
  "good_form", "poor_form", "pain", "injury_flare",
] as const;

export function registerUpdateSession(server: McpServer): void {
  server.registerTool(
    "update_session",
    {
      title: "Update Session",
      description: "Update an existing session with corrected or additional data — title, focus, duration, status, RPE, feedback, exercises, or coach notes.",
      inputSchema: {
        sessionId: z
          .string()
          .min(1)
          .max(200)
          .describe("The session ID to update (from get_training_overview or get_session_details)"),
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
          .describe(
            "Change session status. Setting 'completed' completes the session: without exercises[], " +
            "the planned targets are recorded as performed; with exercises[], the provided work is " +
            "recorded as what was actually done.",
          ),
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
              name: z.string().min(1).max(200).describe(EXERCISE_NAME_DESCRIPTION),
              exerciseId: exerciseIdField,
              sets: z.number().int().min(1).max(50).optional().describe("Number of sets"),
              reps: z.number().int().min(1).max(200).optional().describe("Reps per set"),
              weightKg: z.number().min(0).max(1000).optional().describe("Weight in kg"),
              durationSec: z.number().int().min(0).max(36000).optional().describe("Duration in seconds"),
              distanceMeters: z.number().min(0).max(100000).optional().describe("Distance in meters"),
            }),
          )
          .max(30)
          .optional()
          .describe(
            "Replace session exercises (max 30). Overwrites existing blocks. For phase grouping " +
            "(warm-up/main/cool-down) or supersets/circuits, use blocks[] instead.",
          ),
        blocks: coreWriteBlocksField,
        coachNote: z
          .string()
          .max(2000)
          .optional()
          .describe("AI coach observation or note about this session"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true, title: "Update Session" },
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

        const providedFields = listProvidedUpdateFields(params);
        if (providedFields.length === 0) {
          return {
            content: [{ type: "text" as const, text: "Error: At least one field to update is required" }],
            isError: true,
          };
        }

        // profileId comes ONLY from validated claims, never from tool params.
        const profileId = claims.profile_id;

        const logBridgeFailure = (bridged: BridgeResult) => {
          logToolCall({
            requestId,
            tool: "update_session",
            userPseudonym: claims.sub,
            latencyMs: Date.now() - start,
            success: false,
            error: bridged.error ?? "bridge_error",
          });
        };

        if (isCompletionRequest(params)) {
          if (params.blocks && params.blocks.length > 0) {
            // Teaching error: blocks[] is planned structure; the completion
            // path records performed work.
            return {
              content: [{
                type: "text" as const,
                text: "Error: blocks[] cannot be combined with status 'completed'. blocks[] describes " +
                  "planned structure; to record what was actually performed, send exercises[] with " +
                  "status 'completed' (or use log_completed_session). To restructure the planned " +
                  "session, send blocks[] without a status change.",
              }],
              isError: true,
            };
          }

          // A date change travels as a metadata edit first; the completion
          // write below does not accept date changes by design.
          if (params.scheduledDate != null) {
            const rescheduled = await callCoreBridge("modify_session", profileId, {
              type: "metadata",
              sessionId: params.sessionId,
              scheduledDate: params.scheduledDate,
            });
            const rescheduleFailure = bridgeFailureResponse(rescheduled, "updating session");
            if (rescheduleFailure) {
              logBridgeFailure(rescheduled);
              return rescheduleFailure;
            }
          }

          const bridged = await callCoreBridge(
            "log_session",
            profileId,
            buildUpdateSessionCompletionInput(params),
          );
          const failure = bridgeFailureResponse(bridged, "updating session");
          if (failure) {
            logBridgeFailure(bridged);
            return failure;
          }
          const result = unwrapBridgeResult(bridged);

          logToolCall({
            requestId,
            tool: "update_session",
            userPseudonym: claims.sub,
            latencyMs: Date.now() - start,
            success: true,
          });

          const output = scrubDocument({
            sessionId: params.sessionId,
            title: result.title ?? params.title,
            status: "completed",
            updatedFields: providedFields,
            message: `Session updated: ${providedFields.join(", ")}`,
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          };
        }

        const bridged = await callCoreBridge(
          "modify_session",
          profileId,
          buildUpdateSessionMetadataInput(params),
        );
        const failure = bridgeFailureResponse(bridged, "updating session");
        if (failure) {
          logBridgeFailure(bridged);
          return failure;
        }
        const result = unwrapBridgeResult(bridged);

        logToolCall({
          requestId,
          tool: "update_session",
          userPseudonym: claims.sub,
          latencyMs: Date.now() - start,
          success: true,
        });

        const updatedFields = Array.isArray(result.updatedFields) ?
          (result.updatedFields as string[]) :
          providedFields;
        const output = scrubDocument({
          sessionId: typeof result.sessionId === "string" ? result.sessionId : params.sessionId,
          title: result.title ?? params.title,
          ...(params.status ? { status: params.status } : {}),
          updatedFields,
          message: `Session updated: ${updatedFields.join(", ")}`,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
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
