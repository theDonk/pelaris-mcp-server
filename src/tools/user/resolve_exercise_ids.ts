/**
 * MCP Tool: resolve_exercise_ids
 * Scope: training:read
 *
 * Resolves exercise names to canonical catalog exercise IDs via the wayfinder
 * core `resolve_exercise_ids` over the coreToolsBridge. No local matching:
 * the server-side resolver is the single source of truth for identity, and
 * this wrapper stays wrapper-only (auth/scope/logging/scrub).
 *
 * This is the write preflight: agents call it FIRST to turn the names they
 * plan to write into canonical exercise_id values, then pass `exerciseId` in
 * the write tools so history, "Last" values, and PR detection attach to the
 * right movement. A null match means the catalog has no entry; the agent
 * writes the clean movement name and omits the id.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import { callCoreBridge } from "../shared/bridge_client.js";
import { bridgeFailureResponse, unwrapBridgeResult } from "../shared/core_adapter.js";

export const RESOLVE_EXERCISE_IDS_DESCRIPTION =
  "Resolve exercise names to canonical exercise IDs. Call this FIRST, before any write tool that " +
  "takes exercises: it turns names into canonical exercise_id values you then pass as exerciseId " +
  "in create_planned_session, log_workout, log_completed_session, and update_session, so history, " +
  "'Last' values, and PR detection attach to the right movement. A null match means no catalog " +
  "entry exists; write the clean movement name and omit exerciseId.";

/** Exported for unit tests: the queries[] input field (1-20 movement names). */
export const resolveExerciseIdsQueriesField = z
  .array(z.string().min(1).max(200))
  .min(1)
  .max(20)
  .describe(
    "Exercise names to resolve (1-20), the movement only, e.g. ['Barbell Bench Press', " +
      "'Weighted Chin-up']. Never include grouping or ordering labels (e.g. 'Superset 1A', 'SS 1B').",
  );

export function registerResolveExerciseIds(server: McpServer): void {
  server.registerTool(
    "resolve_exercise_ids",
    {
      title: "Resolve Exercise IDs",
      description: RESOLVE_EXERCISE_IDS_DESCRIPTION,
      inputSchema: {
        queries: resolveExerciseIdsQueriesField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, title: "Resolve Exercise IDs" },
    },
    async ({ queries }) => {
      const requestId = generateRequestId();
      const start = Date.now();
      try {
        const claims = getRequestAuth();
        if (!claims || !hasScope(claims.scope, "training:read")) {
          return {
            content: [{ type: "text" as const, text: "Error: training:read scope required" }],
            isError: true,
          };
        }

        const bridged = await callCoreBridge("resolve_exercise_ids", claims.profile_id, { queries });

        const failure = bridgeFailureResponse(bridged, "resolving exercise ids");
        if (failure) {
          logToolCall({
            requestId,
            tool: "resolve_exercise_ids",
            userPseudonym: claims.sub,
            latencyMs: Date.now() - start,
            success: false,
            error: bridged.error ?? "unknown error",
          });
          return failure;
        }

        const result = unwrapBridgeResult(bridged);
        logToolCall({
          requestId,
          tool: "resolve_exercise_ids",
          userPseudonym: claims.sub,
          latencyMs: Date.now() - start,
          success: true,
        });

        return { content: [{ type: "text" as const, text: JSON.stringify(scrubDocument(result), null, 2) }] };
      } catch (error) {
        logToolCall({
          requestId,
          tool: "resolve_exercise_ids",
          latencyMs: Date.now() - start,
          success: false,
          error: (error as Error).message,
        });
        return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
      }
    },
  );
}
