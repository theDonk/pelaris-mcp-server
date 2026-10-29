/**
 * The connector latency guardrail (MCP_FIXES.md 1.6, 29/10/2026; Brad: "root cause, strategic,
 * scalable, end to end, systematic fix for that slow response stuff").
 *
 * One `admin_alerts/connector_latency_slow_<UTC day>` (warn, routed to Linear by wayfinder's
 * `admin_alert_routing.ts`) the first time a day that a connector `tools/call` takes longer than
 * the SLO's maximum, 5 s: past that, Gemini drops the answer (it answered at 1.3 s and hung at
 * 7.7 s and above). The details carry the request's step latencies, so the alert names the slow
 * step. Numbers and a closed class only: no ids, no tool arguments, no client strings.
 *
 * Called from the protocol-log middleware when the request's line is written. Never throws and
 * never blocks the response (the line is written after the reply).
 */
import type { Firestore } from "firebase-admin/firestore";

import type { McpStepLatencies } from "../logger.js";
import { raiseAdminAlertOncePerDay } from "./admin_alert_once.js";
import { ASSISTANT_CLASSES } from "./token_access.js";

/** Mirrors wayfinder `CONNECTOR_LATENCY_SLOW_CATEGORY` (admin_alert_routing.ts). */
export const CONNECTOR_LATENCY_SLOW_CATEGORY = "connector_latency_slow";

/** The SLO's maximum for one connector tool call (MCP_FIXES.md 1.6). A monitoring line, not a limit on anyone. */
export const SLOW_TOOL_CALL_MS = 5_000;

export interface McpRequestTiming {
  rpcMethods?: readonly string[];
  latencyMs: number;
  steps: McpStepLatencies;
  clientClass?: string | null;
}

export function isSlowToolCall(timing: McpRequestTiming): boolean {
  return (timing.rpcMethods ?? []).includes("tools/call") && timing.latencyMs > SLOW_TOOL_CALL_MS;
}

/** The closed details of the alert. */
export function latencyAlertDetails(timing: McpRequestTiming): Record<string, unknown> {
  const step = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null);
  const clientClass = typeof timing.clientClass === "string" && (ASSISTANT_CLASSES as readonly string[]).includes(timing.clientClass) ?
    timing.clientClass :
    "unknown";
  return {
    latency_ms: Math.round(timing.latencyMs),
    step_latency_ms: {
      auth: step(timing.steps.auth),
      rate_limit: step(timing.steps.rate_limit),
      return_check: step(timing.steps.return_check),
      tool: step(timing.steps.tool),
    },
    client_class: clientClass,
    slo_max_ms: SLOW_TOOL_CALL_MS,
    note: "A connector tool call took longer than the 5 s the SLO allows; Gemini drops an answer that slow. " +
      "step_latency_ms names the slow step. Read the day's mcp_request lines (jsonPayload.event=\"mcp_request\", " +
      "jsonPayload.latencyMs > 5000) for the rest. MCP_FIXES.md section 1.6.",
  };
}

type FirestoreSource = () => Promise<Pick<Firestore, "collection">>;
let firestoreSource: FirestoreSource = async () => (await import("../firestore-client.js")).db;

/** Raise the day's alert for a slow tool call. Returns true only when this call created it. Never throws. */
export async function noteMcpRequestTiming(timing: McpRequestTiming, now: Date = new Date()): Promise<boolean> {
  try {
    if (!isSlowToolCall(timing)) return false;
    return await raiseAdminAlertOncePerDay(await firestoreSource(), {
      category: CONNECTOR_LATENCY_SLOW_CATEGORY,
      severity: "warn",
      details: latencyAlertDetails(timing),
    }, now);
  } catch {
    return false;
  }
}

export function __setLatencyAlertFirestoreForTest(source: FirestoreSource): void {
  firestoreSource = source;
}
