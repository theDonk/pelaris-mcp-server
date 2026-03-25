/**
 * MCP Tool: log_coach_feedback
 * Scope: coach:read
 *
 * Records user feedback about the AI coaching tools.
 * Writes to mcp_feedback/{auto_id} collection for analytics.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "../../firestore-client.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { checkWriteRateLimit } from "../../middleware/rate-limiter.js";
import { logToolCall, generateRequestId } from "../../logger.js";

const VALID_TOOL_NAMES = [
  "get_training_context", "get_active_program", "get_session_details",
  "get_benchmarks", "get_body_analysis", "search_engine_resources",
  "get_coach_insight", "get_onboarding_status",
  "generate_weekly_plan", "modify_training_session", "log_workout",
  "swap_exercise", "update_user_profile", "add_injury",
  "log_coach_feedback", "general",
] as const;

export function registerLogCoachFeedback(server: McpServer): void {
  server.tool(
    "Send Feedback",
    "Share feedback about the coaching experience to help improve tool quality and accuracy.",
    {
      rating: z
        .number()
        .int()
        .min(1)
        .max(5)
        .describe("Overall rating (1 = poor, 5 = excellent)"),
      helpful: z
        .boolean()
        .optional()
        .describe("Was the tool/interaction helpful? Defaults to true if omitted."),
      toolName: z
        .enum(VALID_TOOL_NAMES)
        .optional()
        .describe("Which tool or feature the feedback is about. Defaults to 'general' if omitted."),
      comment: z
        .string()
        .max(1000)
        .optional()
        .describe("Optional freeform feedback comment"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async (params) => {
      const requestId = generateRequestId();
      const start = Date.now();

      try {
        // Auth & scope check
        const claims = getRequestAuth();
        if (!claims || !hasScope(claims.scope, "coach:read")) {
          return {
            content: [{ type: "text" as const, text: "Error: coach:read scope required" }],
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

        const timestamp = new Date().toISOString();
        const resolvedHelpful = params.helpful ?? true;
        const resolvedToolName = params.toolName ?? "general";

        // Write to mcp_feedback collection — pseudonym only, no PII
        const feedbackDoc: Record<string, unknown> = {
          user_pseudonym: claims.sub,
          platform: claims.platform,
          rating: params.rating,
          helpful: resolvedHelpful,
          tool_name: resolvedToolName,
          comment: params.comment || null,
          created_at: timestamp,
        };

        await db.collection("mcp_feedback").add(feedbackDoc);

        logToolCall({
          requestId,
          tool: "log_coach_feedback",
          userPseudonym: claims.sub,
          latencyMs: Date.now() - start,
          success: true,
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "recorded",
              message: "Thank you for your feedback! It helps us improve the coaching experience.",
              rating: params.rating,
              toolName: resolvedToolName,
            }, null, 2),
          }],
        };
      } catch (error) {
        logToolCall({
          requestId,
          tool: "log_coach_feedback",
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
