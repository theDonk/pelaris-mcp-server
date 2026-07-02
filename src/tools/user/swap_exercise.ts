/**
 * MCP Tool: swap_exercise
 * Scope: training:write
 *
 * Finds exercise alternatives based on muscle group / movement pattern.
 * Can suggest 3 alternatives or auto-apply a swap.
 *
 * Migrated onto the coreToolsBridge (WS1.1 wave 2, exercise naming plan
 * 02/07/2026): the direct Firestore body and the local alternatives map are
 * gone. Core swap_exercise owns suggestions and the apply path, resolving
 * session targets through the 3-tier session_target_resolver (planned queue
 * sessions no longer 404) and routing the replacement through the write-time
 * identity ladder, so the swapped-in exercise carries a real exercise_id
 * instead of inheriting the outgoing exercise's id. This wrapper keeps auth,
 * scope, rate-limit, logging, and scrubbing only, and maps the core output
 * back onto the legacy response shape.
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
  unwrapBridgeResult,
} from "../shared/core_adapter.js";

const VALID_REASONS = ["equipment", "injury", "preference"] as const;

/** Tool params after zod validation. Legacy fields map 1:1 onto the core
 *  swap_exercise contract; replacementName is the additive explicit-choice
 *  channel the core contract already speaks. */
export interface SwapExerciseToolParams {
  exerciseName: string;
  sessionId?: string;
  reason?: (typeof VALID_REASONS)[number];
  autoApply?: boolean;
  replacementName?: string;
}

/**
 * Build the core `swap_exercise` input from the tool params. Every legacy
 * field crosses under its own name (the core contract kept the legacy field
 * names); optional fields are omitted when absent, and autoApply=false is
 * preserved (explicit suggestions-only intent). Never includes any profile
 * identifier: profileId travels only as the separate bridge argument, from
 * validated claims. Exported for contract tests.
 */
export function buildSwapExerciseCoreInput(
  params: SwapExerciseToolParams,
): Record<string, unknown> {
  return {
    exerciseName: params.exerciseName,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.reason ? { reason: params.reason } : {}),
    ...(params.autoApply != null ? { autoApply: params.autoApply } : {}),
    ...(params.replacementName ? { replacementName: params.replacementName } : {}),
  };
}

/** Core SwapSuggestion wire shape (rank/exerciseName/rationale plus the
 *  additive catalog exerciseId when the suggestion resolved). */
interface CoreSwapSuggestion {
  rank?: number;
  exerciseName?: string;
  exerciseId?: string;
  rationale?: string;
}

/**
 * Map the core SwapExerciseOutput back onto the legacy response shape this
 * tool has always returned: `original`/`replacement` field names on the
 * swapped path, `alternatives[].name` on the suggestions path, and a `reason`
 * echo defaulting to "preference". The catalog `exerciseId` on suggestions is
 * additive so agents learn canonical ids for follow-up calls. Exported for
 * contract tests.
 */
export function mapCoreSwapOutput(
  core: Record<string, unknown>,
  params: SwapExerciseToolParams,
): Record<string, unknown> {
  const reason = params.reason ?? "preference";
  const sessionId = (core.sessionId as string | undefined) ?? params.sessionId;

  if (core.action === "swapped") {
    return {
      sessionId,
      action: "swapped",
      original: (core.swappedFrom as string | undefined) ?? params.exerciseName,
      replacement: core.swappedTo,
      reason,
      message: core.message,
    };
  }

  const alternatives = Array.isArray(core.alternatives) ?
    (core.alternatives as CoreSwapSuggestion[]).map((alt, i) => ({
      rank: alt.rank ?? i + 1,
      name: alt.exerciseName,
      ...(alt.exerciseId ? { exerciseId: alt.exerciseId } : {}),
      rationale: alt.rationale,
    })) :
    [];

  return {
    ...(sessionId ? { sessionId } : {}),
    action: "suggestions",
    original: params.exerciseName,
    reason,
    alternatives,
    message: core.message,
  };
}

export function registerSwapExercise(server: McpServer): void {
  server.tool(
    "swap_exercise",
    "Find alternative exercises with rationale, or swap an exercise in a planned session. Returns 3 " +
      "suggestions based on movement pattern; set autoApply=true to apply the top suggestion, or pass " +
      "replacementName to choose the replacement yourself.",
    {
      sessionId: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("The session ID (from get_training_overview or get_session_details); omit for general alternatives"),
      exerciseName: z
        .string()
        .min(1)
        .max(200)
        .describe(`Name of the exercise to swap out, as stored in the session. ${EXERCISE_NAME_DESCRIPTION}`),
      reason: z
        .enum(VALID_REASONS)
        .optional()
        .describe("Reason for the swap; helps find better alternatives"),
      autoApply: z
        .boolean()
        .optional()
        .describe("If true, automatically apply the swap to the session (top suggestion unless replacementName is given)"),
      replacementName: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(`Explicit replacement to apply instead of the top suggestion. ${EXERCISE_NAME_DESCRIPTION}`),
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

        // Write rate limit (even for suggestions, prevents abuse)
        const rateLimitError = checkWriteRateLimit(claims.sub);
        if (rateLimitError) {
          return {
            content: [{ type: "text" as const, text: `Error: ${rateLimitError}` }],
            isError: true,
          };
        }

        // profileId comes ONLY from validated claims, never from tool params.
        const bridged = await callCoreBridge(
          "swap_exercise",
          claims.profile_id,
          buildSwapExerciseCoreInput(params),
        );

        const failure = bridgeFailureResponse(bridged, "swapping exercise");
        if (failure) {
          logToolCall({
            requestId,
            tool: "swap_exercise",
            userPseudonym: claims.sub,
            latencyMs: Date.now() - start,
            success: false,
            error: bridged.error ?? "unknown error",
          });
          return failure;
        }

        const result = scrubDocument(mapCoreSwapOutput(unwrapBridgeResult(bridged), params));

        logToolCall({
          requestId,
          tool: "swap_exercise",
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
          tool: "swap_exercise",
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
