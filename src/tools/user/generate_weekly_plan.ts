/**
 * MCP Tool: generate_weekly_plan
 * Scope: training:write
 *
 * Orchestrates the 3-stage program generation pipeline via HTTP call
 * to the Cloud Function endpoint. Returns generated session summaries.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GoogleAuth } from "google-auth-library";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { checkWriteRateLimit } from "../../middleware/rate-limiter.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";

const CF_BASE_URL = "https://australia-southeast1-wayfinder-ai-fitness.cloudfunctions.net";

// Reuse GoogleAuth instance across calls
let _auth: GoogleAuth | null = null;
function getAuth(): GoogleAuth {
  if (!_auth) _auth = new GoogleAuth();
  return _auth;
}

export function registerGenerateWeeklyPlan(server: McpServer): void {
  server.tool(
    "generate_weekly_plan",
    "Generate a new weekly training plan for the authenticated user. Calls the 3-stage generation pipeline (strategy → overviews → sessions). Returns generated session summaries with IDs.",
    {
      focus: z
        .string()
        .max(200)
        .optional()
        .describe("Training focus for the week (e.g., 'upper body strength', 'endurance base building')"),
      daysAvailable: z
        .number()
        .int()
        .min(1)
        .max(7)
        .optional()
        .describe("Number of training days available this week (1-7)"),
      intensityPreference: z
        .enum(["low", "moderate", "high"])
        .optional()
        .describe("Preferred intensity level for the generated plan"),
      notes: z
        .string()
        .max(500)
        .optional()
        .describe("Additional notes or constraints for plan generation"),
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

        // Build request payload
        const payload: Record<string, unknown> = {
          profileId,
          source: "mcp",
        };
        if (params.focus) payload.focus = params.focus;
        if (params.daysAvailable) payload.daysAvailable = params.daysAvailable;
        if (params.intensityPreference) payload.intensityPreference = params.intensityPreference;
        if (params.notes) payload.notes = params.notes;

        // Call Cloud Function with service-to-service auth
        const targetUrl = `${CF_BASE_URL}/generateProgramStrategy`;
        const auth = getAuth();
        const client = await auth.getIdTokenClient(targetUrl);
        const response = await client.request({
          url: targetUrl,
          method: "POST",
          data: payload,
          timeout: 120_000, // 2 minute timeout for generation
        });

        const responseData = response.data as Record<string, unknown>;

        // Extract summary for the user
        const result = scrubDocument({
          status: "generation_initiated",
          jobId: responseData.jobId || responseData.job_id || null,
          message: "Weekly plan generation has been initiated. The 3-stage pipeline (strategy → overviews → sessions) is running. Sessions will appear in your diary once generation completes.",
          constraints: {
            focus: params.focus || "auto-detected from profile",
            daysAvailable: params.daysAvailable || "auto-detected from preferences",
            intensityPreference: params.intensityPreference || "moderate",
          },
          pipelineResponse: responseData,
        });

        logToolCall({
          requestId,
          tool: "generate_weekly_plan",
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
          tool: "generate_weekly_plan",
          latencyMs: Date.now() - start,
          success: false,
          error: (error as Error).message,
        });
        return {
          content: [{ type: "text" as const, text: `Error generating weekly plan: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
