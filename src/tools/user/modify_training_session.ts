/**
 * MCP Tool: modify_training_session
 * Scope: training:write
 *
 * Adjusts a planned session: volume reduction, intensity changes, exercise
 * swaps, rescheduling.
 *
 * Migrated onto the coreToolsBridge (WS1.1, exercise naming plan 02/07/2026):
 * the direct Firestore body is gone. Each legacy modification maps onto a
 * core modify_session operation (scale / swap / reschedule); combined calls
 * apply the operations sequentially in the legacy order. The swap path now
 * resolves the replacement's identity through core's write-time ladder, so
 * the session carries a real exercise_id + provenance instead of keeping the
 * old id under a new name. This wrapper keeps auth, scope, rate-limit,
 * logging, and scrubbing only.
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
  bridgeFailureResponse,
  exerciseIdField,
  unwrapBridgeResult,
} from "../shared/core_adapter.js";
import { buildModifyTrainingOperations } from "./session_modify_mapping.js";

export function registerModifyTrainingSession(server: McpServer): void {
  server.tool(
    "modify_training_session",
    "Adjust a planned session — reduce volume, change intensity, swap exercises, or reschedule to a different date.",
    {
      sessionId: z
        .string()
        .min(1)
        .max(200)
        .describe("The session ID (from get_training_overview or get_session_details)"),
      reduceVolume: z
        .number()
        .min(0.1)
        .max(1.0)
        .optional()
        .describe("Volume multiplier (e.g., 0.5 = halve all sets/reps, 0.75 = reduce by 25%)"),
      increaseIntensity: z
        .number()
        .min(0.5)
        .max(2.0)
        .optional()
        .describe("Intensity multiplier for weights (e.g., 1.1 = increase by 10%)"),
      swapExercise: z
        .object({
          from: z.string().min(1).max(200).describe("Name of the exercise to replace, as it appears in the session"),
          to: z.string().min(1).max(200).describe(EXERCISE_NAME_DESCRIPTION),
          toExerciseId: exerciseIdField,
        })
        .optional()
        .describe("Swap one exercise for another"),
      rescheduleDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
        .optional()
        .describe("New scheduled date in YYYY-MM-DD format"),
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
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

        const operations = buildModifyTrainingOperations({
          sessionId: params.sessionId,
          reduceVolume: params.reduceVolume,
          increaseIntensity: params.increaseIntensity,
          swapExercise: params.swapExercise,
          rescheduleDate: params.rescheduleDate,
        });
        if (operations.length === 0) {
          return {
            content: [{ type: "text" as const, text: "Error: At least one modification is required (reduceVolume, increaseIntensity, swapExercise, or rescheduleDate)" }],
            isError: true,
          };
        }

        // profileId comes ONLY from validated claims, never from tool params.
        const profileId = claims.profile_id;

        const modifications: string[] = [];
        const updatedFields = new Set<string>();
        let title: unknown;

        for (const operation of operations) {
          const bridged = await callCoreBridge("modify_session", profileId, operation.input);
          const failure = bridgeFailureResponse(bridged, operation.action);
          if (failure) {
            // Earlier operations in this call have already been applied by
            // core; tell the agent so it corrects the remainder instead of
            // re-sending the whole combination.
            if (modifications.length > 0) {
              failure.content[0].text += `\n${JSON.stringify({ appliedModifications: modifications })}`;
            }
            logToolCall({
              requestId,
              tool: "modify_training_session",
              userPseudonym: claims.sub,
              latencyMs: Date.now() - start,
              success: false,
              error: bridged.error ?? "bridge_error",
            });
            return failure;
          }
          const result = unwrapBridgeResult(bridged);
          if (typeof result.message === "string") modifications.push(result.message);
          for (const field of (result.updatedFields as string[] | undefined) ?? []) {
            updatedFields.add(field);
          }
          if (result.title != null) title = result.title;
        }

        const output = scrubDocument({
          sessionId: params.sessionId,
          title,
          modifications,
          updatedFields: [...updatedFields],
          message: `Session modified successfully: ${modifications.join("; ")}`,
        });

        logToolCall({
          requestId,
          tool: "modify_training_session",
          userPseudonym: claims.sub,
          latencyMs: Date.now() - start,
          success: true,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        logToolCall({
          requestId,
          tool: "modify_training_session",
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
