/**
 * MCP Tool: generate_weekly_plan
 * Scope: training:write
 *
 * Orchestrates the full 3-stage program generation pipeline via HTTP call
 * to the Cloud Function endpoint. Sessions are written directly to the diary.
 *
 * PEL-229/230/231: Now runs all 3 stages (strategy → overviews → sessions)
 * and writes diary entries. Returns a real jobId for status polling.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GoogleAuth } from "google-auth-library";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { checkWriteRateLimit } from "../../middleware/rate-limiter.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";

const CF_BASE_URL = process.env.CF_BASE_URL || "https://australia-southeast1-wayfinder-ai-fitness.cloudfunctions.net";

let _auth: GoogleAuth | null = null;
function getAuth(): GoogleAuth {
  if (!_auth) _auth = new GoogleAuth();
  return _auth;
}

export function registerGenerateWeeklyPlan(server: McpServer): void {
  server.tool(
    "generate_weekly_plan",
    "Generate a new weekly training plan tailored to your program, goals, and readiness. Sessions are written directly to your calendar.",
    {
      focus: z
        .string()
        .max(500)
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
        .max(2000)
        .optional()
        .describe("Additional notes, goals, constraints, or athlete context for plan generation"),
      durationWeeks: z
        .number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .describe("Number of weeks to generate (1-8, default 4)"),
      startDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
        .optional()
        .describe("Start date for the plan (defaults to next Monday)"),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
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

        // Build request payload
        const payload: Record<string, unknown> = {
          profileId,
          source: "mcp",
        };
        if (params.focus) payload.focus = params.focus;
        if (params.daysAvailable) payload.daysAvailable = params.daysAvailable;
        if (params.intensityPreference) payload.intensityPreference = params.intensityPreference;
        if (params.notes) payload.notes = params.notes;
        if (params.durationWeeks) payload.durationWeeks = params.durationWeeks;
        if (params.startDate) payload.startDate = params.startDate;

        // Call full-pipeline HTTP Cloud Function
        const targetUrl = `${CF_BASE_URL}/generateProgramHttp`;
        const auth = getAuth();
        const client = await auth.getIdTokenClient(targetUrl);
        const response = await client.request({
          url: targetUrl,
          method: "POST",
          data: payload,
          timeout: 570_000, // 9.5 min — slightly more than CF's 540s to avoid client-side timeout race
        });

        const responseData = response.data as Record<string, unknown>;

        // Build user-facing result
        const pipelineStatus = responseData.status as string;
        const isComplete = pipelineStatus === "complete";
        const isPartial = pipelineStatus === "partial";
        const sessionsWritten = (responseData.sessionsWritten as number) || 0;
        const jobId = responseData.jobId || null;

        let statusMessage: string;
        if (isComplete) {
          statusMessage = `Training plan generated successfully! ${sessionsWritten} sessions have been added to your diary.`;
        } else if (isPartial) {
          statusMessage = `Training plan partially generated. ${sessionsWritten} sessions were added to your diary, but some weeks encountered errors. Use get_generation_status(jobId) for details.`;
        } else {
          statusMessage = "Weekly plan generation has been initiated. Use get_generation_status to check progress.";
        }

        const result = scrubDocument({
          status: isComplete ? "complete" : isPartial ? "partial" : "generation_initiated",
          jobId,
          programName: responseData.programName || null,
          sessionsWritten,
          message: statusMessage,
          plan: {
            totalWeeks: responseData.totalWeeks || null,
            macroStructure: responseData.macroStructure || null,
            focus: params.focus || "auto-detected from profile",
            daysAvailable: params.daysAvailable || "auto-detected from preferences",
            intensityPreference: params.intensityPreference || "moderate",
          },
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
