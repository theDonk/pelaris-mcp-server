/**
 * Protocol-level request log middleware for /mcp.
 *
 * One allow-listed `mcp_request` line per HTTP request to /mcp, so 401s and the GET/DELETE
 * 405s are seen too. Mounted after `express.json()`: a body express.json rejects (malformed
 * JSON, 400) never reaches it, so that request writes no line.
 *
 * The line is written exactly once, when the response finishes OR the connection closes,
 * whichever comes first. A client that hangs up before we reply still writes a line, with
 * `completed: false`.
 *
 * The request id is minted here and shared through `res.locals.mcpRequestId`, so the /mcp
 * handler's lines join this one. Describing the request or writing the line can never
 * fail the request: every step is guarded.
 */
import type { NextFunction, Request, Response } from "express";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

import type { McpAuthenticatedRequest } from "../auth.js";
import { noteMcpRequestTiming } from "../connector/latency_alert.js";
import {
  describeMcpRequest,
  generateRequestId,
  logMcpRequest,
  type McpRequestDescription,
  type McpStepLatencies,
} from "../logger.js";

/** The `res.locals` key the /mcp handler reads the shared request id from. */
export const MCP_REQUEST_ID_LOCAL = "mcpRequestId";

/** The `res.locals` key holding this request's step latencies. */
export const MCP_STEPS_LOCAL = "mcpSteps";

export function mcpProtocolLog(req: Request, res: Response, next: NextFunction): void {
  const started = Date.now();
  const requestId = generateRequestId();
  res.locals[MCP_REQUEST_ID_LOCAL] = requestId;
  const steps: McpStepLatencies = {};
  res.locals[MCP_STEPS_LOCAL] = steps;
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
      const latencyMs = Date.now() - started;
      const clientClass = (req as McpAuthenticatedRequest).connectorAccess?.assistantClass ?? undefined;
      logMcpRequest({
        requestId,
        httpMethod: req.method,
        status: res.statusCode,
        completed: res.writableFinished,
        latencyMs,
        client_class: clientClass,
        stepLatencyMs: steps,
        description,
      });
      // One admin alert a day for a tool call slower than the connector_slow_call_alert_ms dial (never throws).
      void noteMcpRequestTiming({ rpcMethods: description?.rpcMethods, latencyMs, steps, clientClass });
    } catch {
      // Observability only.
    }
  };
  res.once("finish", writeOnce);
  res.once("close", writeOnce);
  next();
}

/** This request's step latencies (a fresh, unlogged object if the middleware did not run). */
export function mcpStepsFor(res: Response): McpStepLatencies {
  const steps = res.locals[MCP_STEPS_LOCAL];
  return steps && typeof steps === "object" ? steps as McpStepLatencies : {};
}

/**
 * Wrap a middleware so the time until it calls `next` lands in `stepLatencyMs[step]` (a
 * middleware that answers itself, a 401 say, records nothing: the line's `latencyMs` is then
 * that step's time).
 */
export function timedStep(
  step: keyof McpStepLatencies,
  middleware: (req: Request, res: Response, next: NextFunction) => unknown,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const started = Date.now();
    const steps = mcpStepsFor(res);
    const done: NextFunction = (error?: unknown) => {
      steps[step] = (steps[step] ?? 0) + (Date.now() - started);
      next(error as never);
    };
    try {
      const result = middleware(req, res, done);
      if (result && typeof (result as Promise<unknown>).catch === "function") (result as Promise<unknown>).catch(next);
    } catch (error) {
      next(error as never);
    }
  };
}

/** The shared id for this /mcp request, or a fresh one if the middleware did not run. */
export function mcpRequestIdFor(res: Response): string {
  const shared = res.locals[MCP_REQUEST_ID_LOCAL];
  return typeof shared === "string" && shared.length > 0 ? shared : generateRequestId();
}
