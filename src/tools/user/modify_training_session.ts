/**
 * MCP Tool: modify_training_session
 * Scope: training:write
 *
 * Compatibility wrapper around the MCP session-write core. Supports diary IDs,
 * queue session IDs, and plan_ display IDs without bypassing the repaired
 * target-resolution and identity-preserving write path.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { checkWriteRateLimit } from "../../middleware/rate-limiter.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import {
  modifyTrainingSessionCore,
  type ModifyTrainingSessionInput,
} from "./session_write_core.js";

export function registerModifyTrainingSession(server: McpServer): void {
  server.tool(
    "modify_training_session",
    "Adjust a planned session - reduce volume, change intensity, swap exercises, or reschedule to a different date. Supports diary IDs, queue session IDs, and plan_ display IDs.",
    {
      sessionId: z.string().min(1).max(200).describe("Diary ID, queue session ID, or plan_ display ID"),
      reduceVolume: z.number().min(0.1).max(1.0).optional().describe("Volume multiplier"),
      increaseIntensity: z.number().min(0.5).max(2.0).optional().describe("Intensity multiplier"),
      swapExercise: z.object({
        from: z.string().min(1).max(200).describe("Name of the exercise to replace"),
        to: z.string().min(1).max(200).describe("Name of the replacement exercise"),
      }).optional(),
      rescheduleDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
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

        const result = await modifyTrainingSessionCore(claims.profile_id, params as ModifyTrainingSessionInput);
        logToolCall({
          requestId,
          tool: "modify_training_session",
          userPseudonym: claims.sub,
          latencyMs: Date.now() - start,
          success: true,
          extras: {
            resolved_target_type: result.resolvedTargetType,
            queue_id: result.queueId,
          },
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(scrubDocument({ ...result }), null, 2) }],
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
