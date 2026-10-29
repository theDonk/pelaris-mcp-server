/**
 * Structured JSON logging for the Pelaris MCP server.
 *
 * Replaces console.log with structured output for Cloud Run / Cloud Logging.
 * Logs include: tool name, user pseudonym (never UID), latency, success/failure.
 */

import crypto from "crypto";

import { noteConnectorToolSuccess } from "./connector/connector_use.js";

export interface LogEntry {
  severity: "INFO" | "WARN" | "ERROR" | "DEBUG";
  message: string;
  requestId?: string;
  tool?: string;
  userPseudonym?: string;
  latencyMs?: number;
  success?: boolean;
  error?: string;
  [key: string]: unknown;
}

/**
 * Generate a unique request ID for tracing.
 */
export function generateRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Write a structured log entry to stdout (picked up by Cloud Logging).
 */
export function log(entry: LogEntry): void {
  const { severity, message, ...rest } = entry;
  const output = {
    severity,
    message,
    timestamp: new Date().toISOString(),
    ...rest,
  };
  // Cloud Run picks up structured JSON from stdout
  process.stdout.write(JSON.stringify(output) + "\n");
}

/**
 * Log a tool invocation with timing.
 *
 * `extras` is spread into the log entry — used for structured observability
 * fields like `legacy_origin: true` from ownership verification (H-03).
 */
export function logToolCall(params: {
  requestId: string;
  tool: string;
  userPseudonym?: string;
  latencyMs: number;
  success: boolean;
  error?: string;
  extras?: Record<string, unknown>;
}): void {
  log({
    severity: params.success ? "INFO" : "ERROR",
    message: `tool_call: ${params.tool}`,
    requestId: params.requestId,
    tool: params.tool,
    userPseudonym: params.userPseudonym || "anonymous",
    latencyMs: params.latencyMs,
    success: params.success,
    error: params.error,
    ...(params.extras ?? {}),
  });
  // B2a C6 (d), FL-9 1.6: presence through ChatGPT or Claude. Its own closed
  // line (tool_call stays pseudonym-only); only under OAuth facts the
  // ownership check allowed, never for admin auth.
  if (params.success) noteConnectorToolSuccess();
}

/**
 * Log server lifecycle events.
 */
export function logServer(message: string, extra?: Record<string, unknown>): void {
  log({
    severity: "INFO",
    message,
    ...extra,
  });
}

// ─── Protocol-level request log (MCP_FIXES.md §1.4 step 1b) ─────────────────────────
//
// One line per HTTP request to /mcp, so a client that misbehaves (Gemini, 28/10/2026) can be
// diagnosed from evidence: which JSON-RPC methods it sent, which protocol version it asked
// for, which one we answered, and how the transport headers looked. ALLOW-LIST ONLY: never
// arguments, results, tokens, the Authorization header, emails, uids or profile ids. Every
// string is length-capped and stripped of control characters, because clientInfo and headers
// are client-controlled.

const MAX_FIELD = 120;

function cleanField(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MAX_FIELD);
}

function headerValue(headers: Record<string, unknown>, name: string): string | undefined {
  const raw = headers[name];
  return cleanField(Array.isArray(raw) ? raw.join(",") : raw);
}

/** At most this many method names per line; `rpcMessageCount` keeps the true size (security F1). */
const MAX_LOGGED_METHODS = 10;

/**
 * Only spec method names are logged verbatim; anything else is "(other)", so a client can't
 * write free text (an email, say) into the log through `method` (security F2).
 */
const KNOWN_METHOD = /^(initialize|ping|server\/discover|subscriptions\/listen|(tools|resources|prompts|notifications|logging|completion|tasks|elicitation|sampling|roots)\/[a-z_]+(\/[a-z_]+)?)$/i;

export interface McpRequestDescription {
  rpcMethods: string[];
  rpcMessageCount: number;
  clientProtocolVersion?: string;
  clientName?: string;
  clientVersion?: string;
  negotiatedProtocolVersion?: string;
  accept?: string;
  mcpProtocolVersionHeader?: string;
}

/**
 * Pure: the allow-listed facts about one /mcp request. `supportedVersions` and
 * `latestVersion` are the SDK's, so `negotiatedProtocolVersion` mirrors what the SDK answers
 * an `initialize` with (the requested version when supported, otherwise its latest).
 */
export function describeMcpRequest(
  body: unknown,
  headers: Record<string, unknown>,
  supportedVersions: readonly string[],
  latestVersion: string,
): McpRequestDescription {
  const messages = Array.isArray(body) ? body : [body];
  const rpcMethods: string[] = [];
  const description: McpRequestDescription = { rpcMethods, rpcMessageCount: 0 };
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    description.rpcMessageCount++;
    const { method, params } = message as { method?: unknown; params?: unknown };
    const raw = cleanField(method);
    const name = raw && KNOWN_METHOD.test(raw) ? raw : undefined;
    let label: string | undefined;
    if (name) label = name;
    else if (raw) label = "(other)";
    else if ("result" in (message as object) || "error" in (message as object)) label = "(response)";
    else if (Object.keys(message as object).length > 0) label = "(unknown)";
    if (label && rpcMethods.length < MAX_LOGGED_METHODS) rpcMethods.push(label);
    if (name === "initialize" && params && typeof params === "object") {
      const { protocolVersion, clientInfo } = params as { protocolVersion?: unknown; clientInfo?: unknown };
      description.clientProtocolVersion = cleanField(protocolVersion);
      if (clientInfo && typeof clientInfo === "object") {
        const info = clientInfo as { name?: unknown; version?: unknown };
        description.clientName = cleanField(info.name);
        description.clientVersion = cleanField(info.version);
      }
      if (description.clientProtocolVersion) {
        description.negotiatedProtocolVersion = supportedVersions.includes(description.clientProtocolVersion) ?
          description.clientProtocolVersion :
          latestVersion;
      }
    }
  }
  description.accept = headerValue(headers, "accept");
  description.mcpProtocolVersionHeader = headerValue(headers, "mcp-protocol-version");
  return description;
}

/**
 * Write the protocol line. Never throws: a logging fault must not reach the request path.
 */
export function logMcpRequest(params: {
  requestId: string;
  httpMethod: string;
  status: number;
  durationMs: number;
  clientClass?: string;
  description?: McpRequestDescription;
}): void {
  try {
    log({
      severity: "INFO",
      message: "mcp_request",
      event: "mcp_request",
      requestId: params.requestId,
      httpMethod: params.httpMethod,
      status: params.status,
      durationMs: params.durationMs,
      ...(params.clientClass ? { clientClass: params.clientClass } : {}),
      ...(params.description ?? {}),
    });
  } catch {
    // Observability only: swallow.
  }
}
