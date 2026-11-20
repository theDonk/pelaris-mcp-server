/**
 * MCP Tool: card_skip_session (app-only)
 * Scope: training:write
 *
 * The Week card's Skip, after the athlete confirms. It marks one planned session as
 * skipped through the app's own skip (core `skip_session` over the coreToolsBridge), so
 * the session stays in the plan and in the diary as skipped, exactly as a skip made in
 * Pelaris. App-only (`visibility: ["app"]`): the card may call it, and a host MUST NOT
 * offer it to the model. Registered only for a host that draws cards.
 *
 * This wrapper keeps auth, scope, the write rate limit, logging and scrubbing only.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { checkWriteRateLimit } from "../../middleware/rate-limiter.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import { callCoreBridge } from "../shared/bridge_client.js";
import { bridgeFailureResponse, unwrapBridgeResult } from "../shared/core_adapter.js";
import { cardCallableToolMeta, cardsOn } from "../../cards/card_shell.js";
import { currentHostProfile, type HostProfile } from "../../cards/host.js";
import { CARD_SESSION_ID } from "./modify_training_session.js";

export const CARD_SKIP_TOOL = "card_skip_session";

/** Stored as the skip's reason: where the skip was made. The card asks for no reason. */
export const CARD_SKIP_REASON = "Skipped from the week card";

/** The only input the card's skip tool takes. Strict: any other key is refused. */
export const CARD_SKIP_INPUT = z
  .object({
    sessionId: z.string().regex(CARD_SESSION_ID, "Not a session id").describe("The planned session to skip"),
  })
  .strict();

type ToolReply = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

async function runCardSkipSession(sessionId: string): Promise<ToolReply> {
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

    // profileId comes ONLY from validated claims, never from tool params.
    const bridged = await callCoreBridge("skip_session", claims.profile_id, { sessionId, reason: CARD_SKIP_REASON });
    const failure = bridgeFailureResponse(bridged, "skipping session");
    if (failure) {
      logToolCall({
        requestId,
        tool: CARD_SKIP_TOOL,
        userPseudonym: claims.sub,
        latencyMs: Date.now() - start,
        success: false,
        error: bridged.error ?? "bridge_error",
      });
      return failure;
    }
    const result = unwrapBridgeResult(bridged);
    const output = scrubDocument({
      skipped: [{ sessionId }],
      title: result.title,
      message: "Session skipped. It stays in your plan as skipped.",
    });
    logToolCall({ requestId, tool: CARD_SKIP_TOOL, userPseudonym: claims.sub, latencyMs: Date.now() - start, success: true });
    return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
  } catch (error) {
    logToolCall({ requestId, tool: CARD_SKIP_TOOL, latencyMs: Date.now() - start, success: false, error: (error as Error).message });
    return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
  }
}

export function registerCardSkipSession(server: McpServer, host: HostProfile = currentHostProfile()): void {
  if (!cardsOn(host)) return;
  server.registerTool(
    CARD_SKIP_TOOL,
    {
      title: "Skip a session (week card)",
      description: "Used by the Pelaris week card when the athlete confirms a skip: marks one planned session as skipped. The session stays in the plan.",
      inputSchema: CARD_SKIP_INPUT,
      // Not idempotent: a repeat finds the session already skipped and answers with an error.
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false, title: "Skip a session (week card)" },
      _meta: cardCallableToolMeta(process.env, host),
    },
    async (params) => runCardSkipSession(params.sessionId),
  );
}
