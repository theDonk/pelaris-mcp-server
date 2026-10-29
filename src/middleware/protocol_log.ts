/**
 * Protocol-level request log middleware for /mcp (MCP_FIXES.md §1.4 step 1b).
 *
 * One allow-listed `mcp_request` line per HTTP request to /mcp, so 401s and the GET/DELETE
 * 405s are seen too. Mounted after `express.json()`: a body express.json rejects (malformed
 * JSON, 400) never reaches it, so that request writes no line (security round 2, F2; see
 * MCP_FIXES.md §1).
 *
 * The line is written exactly once, when the response finishes OR the connection closes,
 * whichever comes first (security round 2, F1). A client that hangs up before we reply (very
 * likely what Gemini's stall looks like from our side) still writes a line, with
 * `completed: false`.
 *
 * The request id is minted here and shared through `res.locals.mcpRequestId`, so the /mcp
 * handler's lines join this one (F6). Describing the request or writing the line can never
 * fail the request: every step is guarded.
 */
import type { NextFunction, Request, Response } from "express";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

import type { McpAuthenticatedRequest } from "../auth.js";
import { describeMcpRequest, generateRequestId, logMcpRequest, type McpRequestDescription } from "../logger.js";

/** The `res.locals` key the /mcp handler reads the shared request id from. */
export const MCP_REQUEST_ID_LOCAL = "mcpRequestId";

export function mcpProtocolLog(req: Request, res: Response, next: NextFunction): void {
  const started = Date.now();
  const requestId = generateRequestId();
  res.locals[MCP_REQUEST_ID_LOCAL] = requestId;
  let description: McpRequestDescription | undefined;
  try {
    description = describeMcpRequest(req.body, req.headers, SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION);
  } catch {
    description = undefined;
  }
  let written = false;
  const writeOnce = () => {
    // Inside an EventEmitter listener a throw would be uncaught, so the whole body is guarded.
    try {
      if (written) return;
      written = true;
      logMcpRequest({
        requestId,
        httpMethod: req.method,
        status: res.statusCode,
        completed: res.writableFinished,
        durationMs: Date.now() - started,
        clientClass: (req as McpAuthenticatedRequest).connectorAccess?.assistantClass ?? undefined,
        description,
      });
    } catch {
      // Observability only.
    }
  };
  res.once("finish", writeOnce);
  res.once("close", writeOnce);
  next();
}

/** The shared id for this /mcp request, or a fresh one if the middleware did not run. */
export function mcpRequestIdFor(res: Response): string {
  const shared = res.locals[MCP_REQUEST_ID_LOCAL];
  return typeof shared === "string" && shared.length > 0 ? shared : generateRequestId();
}
