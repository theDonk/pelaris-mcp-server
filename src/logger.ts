/**
 * Structured JSON logging for the Pelaris MCP server.
 *
 * Replaces console.log with structured output for Cloud Run / Cloud Logging.
 * Logs include: tool name, user pseudonym (never UID), latency, success/failure.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "crypto";

import { normaliseClientString } from "./client_string.js";
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
 * The id of the /mcp HTTP request being served. The protocol-log
 * middleware mints it and puts it on `res.locals.mcpRequestId`; the /mcp handler reuses it as
 * its own `requestId` and runs the request inside `runWithMcpRequestId`, so every line written
 * while serving it (each tool's `tool_call`, the handler's error line) carries `mcpRequestId`
 * and joins the request's `mcp_request` line.
 */
/**
 * Where the time of one /mcp request goes: milliseconds per step, written on
 * the request's `mcp_request` line as `stepLatencyMs`. `tool` sums the `latencyMs` of every
 * `tool_call` logged while serving the request.
 */
export interface McpStepLatencies {
  auth?: number;
  rate_limit?: number;
  return_check?: number;
  tool?: number;
}

const mcpRequestStore = new AsyncLocalStorage<{ id: string; steps?: McpStepLatencies }>();

export function runWithMcpRequestId<T>(mcpRequestId: string, fn: () => T, steps?: McpStepLatencies): T {
  return mcpRequestStore.run({ id: mcpRequestId, steps }, fn);
}

export function currentMcpRequestId(): string | undefined {
  return mcpRequestStore.getStore()?.id;
}

/** Add `ms` to a step of the request being served (no-op outside one). */
export function addStepLatency(step: keyof McpStepLatencies, ms: number, steps = mcpRequestStore.getStore()?.steps): void {
  if (!steps || !Number.isFinite(ms) || ms < 0) return;
  steps[step] = (steps[step] ?? 0) + Math.round(ms);
}

/**
 * Write a structured log entry to stdout (picked up by Cloud Logging).
 */
export function log(entry: LogEntry): void {
  const { severity, message, ...rest } = entry;
  const mcpRequestId = currentMcpRequestId();
  const output = {
    severity,
    message,
    timestamp: new Date().toISOString(),
    ...rest,
    ...(mcpRequestId && mcpRequestId !== rest.requestId ? { mcpRequestId } : {}),
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
  addStepLatency("tool", params.latencyMs);
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

// ─── Protocol-level request log ──────────────────────────────────────────────────────
//
// One line per HTTP request to /mcp, so a client's behaviour can be diagnosed from evidence: which JSON-RPC methods it sent, which protocol version it asked
// for, which one we answered, and how the transport headers looked. ALLOW-LIST ONLY: never
// arguments, results, tokens, the Authorization header, emails, uids or profile ids. Every
// string is length-capped and stripped of control characters, because clientInfo and headers
// are client-controlled.

const MAX_FIELD = 120;

function cleanField(value: unknown): string | undefined {
  // The one client-string cleaner (src/client_string.ts), capped at 120 for the log.
  return normaliseClientString(value, MAX_FIELD) ?? undefined;
}

/**
 * `clientInfo` is written by the client and arrives before authentication, so it is logged
 * even on a 401. A value that holds an "@" (an email, a handle) after
 * NFKC folding (so a full-width at sign counts too) is replaced whole, never logged.
 */
export const REDACTED = "(redacted)";

function cleanClientIdentity(value: unknown): string | undefined {
  const cleaned = cleanField(value);
  if (cleaned === undefined) return undefined;
  return cleaned.normalize("NFKC").includes("@") ? REDACTED : cleaned;
}

function headerValue(headers: Record<string, unknown>, name: string): string | undefined {
  const raw = headers[name];
  return cleanField(Array.isArray(raw) ? raw.join(",") : raw);
}

/** At most this many method names per line; `rpcMessageCount` keeps the true size. */
const MAX_LOGGED_METHODS = 10;

/**
 * The MCP method names logged verbatim: exactly the JSON-RPC methods of the spec versions this
 * server answers (2024-11-05 to 2025-11-25: the SDK's `ClientRequest`, `ClientNotification`,
 * `ServerRequest` and `ServerNotification` unions; a lockstep test fails if the SDK grows one
 * this set lacks), plus the two 2026-07-28 methods a newer client may probe with. Anything else
 * is "(other)", so a client can't write free text into the log through `method`, not even under
 * a known prefix such as `notifications/<name>`.
 */
export const MCP_SPEC_METHODS: ReadonlySet<string> = new Set([
  // Lifecycle and utilities
  "initialize",
  "ping",
  "logging/setLevel",
  "completion/complete",
  // Tools, resources, prompts
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "resources/subscribe",
  "resources/unsubscribe",
  "prompts/list",
  "prompts/get",
  // Tasks (2025-11-25)
  "tasks/get",
  "tasks/result",
  "tasks/list",
  "tasks/cancel",
  // Server-to-client requests (a client never sends these, but a confused one might echo one)
  "sampling/createMessage",
  "roots/list",
  "elicitation/create",
  // Notifications
  "notifications/initialized",
  "notifications/cancelled",
  "notifications/progress",
  "notifications/message",
  "notifications/roots/list_changed",
  "notifications/resources/updated",
  "notifications/resources/list_changed",
  "notifications/tools/list_changed",
  "notifications/prompts/list_changed",
  "notifications/tasks/status",
  "notifications/elicitation/complete",
  // 2026-07-28 spec; not in the v1 SDK
  "server/discover",
  "subscriptions/listen",
]);

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
    const name = raw && MCP_SPEC_METHODS.has(raw) ? raw : undefined;
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
        description.clientName = cleanClientIdentity(info.name);
        description.clientVersion = cleanClientIdentity(info.version);
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
  /** `res.writableFinished`: false when the client went away before the reply was sent. */
  completed: boolean;
  /** The whole request, ms (the shared `latencyMs` key). */
  latencyMs: number;
  /** The token's assistant class (the shared `client_class` key). */
  client_class?: string;
  stepLatencyMs?: McpStepLatencies;
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
      completed: params.completed,
      latencyMs: params.latencyMs,
      ...(params.client_class ? { client_class: params.client_class } : {}),
      ...(params.stepLatencyMs && Object.keys(params.stepLatencyMs).length > 0 ? { stepLatencyMs: params.stepLatencyMs } : {}),
      ...(params.description ?? {}),
    });
  } catch {
    // Observability only: swallow.
  }
}
