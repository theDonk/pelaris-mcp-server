/**
 * MCP Tool: update_session
 * Scope: training:write
 *
 * Compatibility wrapper around the MCP session-write core. The wrapper keeps
 * the public MCP tool name stable while sharing target resolution, patch-first
 * exercise writes, exercise identity, and completed/imported guards with the
 * repaired Coach write semantics.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { checkWriteRateLimit } from "../../middleware/rate-limiter.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import {
  updateSessionCore,
  type UpdateSessionInput,
} from "./session_write_core.js";

const VALID_STATUSES = ["planned", "completed"] as const;
const VALID_FEEDBACK_TAGS = [
  "felt_strong", "felt_tired", "felt_energetic", "felt_sluggish",
  "good_form", "poor_form", "pain", "injury_flare",
] as const;

export function registerUpdateSession(server: McpServer): void {
  server.tool(
    "update_session",
    "Update an existing session with corrected or additional data - title, focus, duration, status, RPE, feedback, exercises, or coach notes. Supports diary IDs, queue session IDs, and plan_ display IDs.",
    {
      sessionId: z.string().min(1).max(200).describe("Diary ID, queue session ID, or plan_ display ID to update"),
      title: z.string().max(200).optional().describe("Updated session title"),
      sessionFocus: z.string().max(200).optional().describe("Updated session focus area"),
      durationMinutes: z.number().int().min(1).max(480).optional().describe("Updated duration in minutes"),
      status: z.enum(VALID_STATUSES).optional().describe("Change session status"),
      scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format").optional(),
      rpe: z.number().int().min(1).max(10).optional().describe("Rate of perceived exertion"),
      feedbackTags: z.array(z.enum(VALID_FEEDBACK_TAGS)).max(5).optional(),
      feedbackNote: z.string().max(1000).optional(),
      exercises: z.array(
        z.object({
          name: z.string().min(1).max(200),
          exerciseId: z.string().min(1).max(200).optional(),
          sets: z.number().int().min(1).max(50).optional(),
          reps: z.number().int().min(1).max(200).optional(),
          weightKg: z.number().min(0).max(1000).optional(),
          durationSec: z.number().int().min(0).max(36000).optional(),
          distanceMeters: z.number().min(0).max(100000).optional(),
        }),
      ).max(30).optional().describe("Patch session exercises. Existing blocks and unrelated exercises are preserved."),
      coachNote: z.string().max(2000).optional(),
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

        const result = await updateSessionCore(claims.profile_id, params as UpdateSessionInput);
        logToolCall({
          requestId,
          tool: "update_session",
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
