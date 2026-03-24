/**
 * Structured JSON logging for the Pelaris MCP server.
 *
 * Replaces console.log with structured output for Cloud Run / Cloud Logging.
 * Logs include: tool name, user pseudonym (never UID), latency, success/failure.
 */

import crypto from "crypto";

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
 */
export function logToolCall(params: {
  requestId: string;
  tool: string;
  userPseudonym?: string;
  latencyMs: number;
  success: boolean;
  error?: string;
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
  });
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
