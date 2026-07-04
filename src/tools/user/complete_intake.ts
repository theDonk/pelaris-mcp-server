/**
 * MCP Tool: complete_intake
 * Scope: training:write (no profile:write scope exists; mirrors update_user_profile)
 *
 * Lets the coach/agent complete a user's intake conversationally and persist it
 * (intake run doc + profile projection) via the wayfinder core `complete_intake`
 * over the coreToolsBridge. The coach gathers the structured answers (and may
 * supply a QUALITY projection it standardised), then calls this; the server
 * derives the SAFETY-critical fields (pregnancy/injury/demographics) from the
 * answers verbatim and refuses to silently complete when a blocking safety
 * answer (is_pregnant) is missing, returning a clarification the coach must ask.
 *
 * After this, the coach can call generate_program (intake context now persisted).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { checkWriteRateLimit } from "../../middleware/rate-limiter.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import { callCoreBridge } from "../shared/bridge_client.js";

export function registerCompleteIntake(server: McpServer): void {
  server.registerTool(
    "complete_intake",
    {
      title: "Complete Intake",
      description: "Complete and save the athlete's intake so a program can be generated. If a required safety field (e.g. pregnancy) is missing, the response indicates what still needs to be answered.",
      inputSchema: {
        answers: z.record(z.unknown()).describe(
          "Structured intake answers gathered from the athlete (e.g. is_pregnant, injuries, goal, experience). Safety fields (is_pregnant, injuries, demographics) are taken from here verbatim.",
        ),
        freeText: z.record(z.unknown()).optional().describe("Optional free-text fields, e.g. { north_star_raw: '...' }"),
        projection: z.record(z.unknown()).optional().describe(
          "Optional quality projection you standardised (intakeSummary, detectedMethodologyId, recommendedDurationWeeks, goals, a non-safety trainingContextProjection). Safety fields here are ignored; the answers are authoritative.",
        ),
        runId: z.string().max(120).optional().describe("Optional intake run id; generated if omitted."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false, title: "Complete Intake" },
    },
    async (params) => {
      const requestId = generateRequestId();
      const start = Date.now();
      try {
        const claims = getRequestAuth();
        if (!claims || !hasScope(claims.scope, "training:write")) {
          return { content: [{ type: "text" as const, text: "Error: training:write scope required" }], isError: true };
        }
        const rateLimitError = checkWriteRateLimit(claims.sub);
        if (rateLimitError) {
          return { content: [{ type: "text" as const, text: `Error: ${rateLimitError}` }], isError: true };
        }

        const bridged = await callCoreBridge("complete_intake", claims.profile_id, {
          ...(params.runId ? { runId: params.runId } : {}),
          answers: params.answers,
          ...(params.freeText ? { freeText: params.freeText } : {}),
          ...(params.projection ? { projection: params.projection } : {}),
        });

        if (!bridged.ok || bridged.result == null) {
          return {
            content: [{ type: "text" as const, text: `Error completing intake: ${bridged.error ?? "unknown error"}` }],
            isError: true,
          };
        }

        const result = bridged.result as Record<string, unknown>;
        logToolCall({
          requestId,
          tool: "complete_intake",
          userPseudonym: claims.sub,
          latencyMs: Date.now() - start,
          success: true,
        });

        // Clarification-required: surface the questions for the coach to ask;
        // NOT an error (it is the safe, expected path when a blocking safety
        // answer is missing). The coach asks, then re-calls with the answer.
        if (result.status === "clarification_required") {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { status: "clarification_required", message: "More information is needed before intake can be completed safely.", missing: result.missing },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // Project to an explicit allow-list of user-facing fields. The raw core
        // envelope can carry internal handles/projection fields (runId,
        // detectedMethodologyId, trainingContextProjection, ...) the model never
        // needs; only surface the outcome fields that help the coach proceed.
        const INTAKE_RESPONSE_FIELDS = [
          "status",
          "message",
          "recommendedDurationWeeks",
          "goals",
        ] as const;
        const projected: Record<string, unknown> = {};
        for (const key of INTAKE_RESPONSE_FIELDS) {
          if (result[key] !== undefined) projected[key] = result[key];
        }
        if (projected.status === undefined) projected.status = "completed";

        return { content: [{ type: "text" as const, text: JSON.stringify(scrubDocument(projected), null, 2) }] };
      } catch (error) {
        logToolCall({
          requestId,
          tool: "complete_intake",
          latencyMs: Date.now() - start,
          success: false,
          error: (error as Error).message,
        });
        return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
      }
    },
  );
}
