/**
 * Connector latency alert.
 *
 * Raises one `admin_alerts/connector_latency_slow_<UTC day>` (warn) the first time a day that a
 * connector `tools/call` takes longer than the `connector_slow_call_alert_ms` dial
 * (`system_config/jit_controls`, read through `peekGatewayDials`, never awaited). The details carry
 * the request's step latencies so the alert names the slow step. Numbers and a closed class only:
 * no ids, no tool arguments, no client strings.
 *
 * Called from the protocol-log middleware after the request's line is written. Never throws and
 * never delays the response.
 */
import type { Firestore } from "firebase-admin/firestore";

import type { McpStepLatencies } from "../logger.js";
import { raiseAdminAlertOncePerDay } from "./admin_alert_once.js";
import { peekGatewayDials } from "./dials.js";
import { ASSISTANT_CLASSES } from "./token_access.js";

/** Mirrors wayfinder's `CONNECTOR_LATENCY_SLOW_CATEGORY`; the cross-repo drift check compares them. */
export const CONNECTOR_LATENCY_SLOW_CATEGORY = "connector_latency_slow";

export interface McpRequestTiming {
  rpcMethods?: readonly string[];
  latencyMs: number;
  steps: McpStepLatencies;
  clientClass?: string | null;
}

export function isSlowToolCall(timing: McpRequestTiming, thresholdMs: number = peekGatewayDials().connectorSlowCallAlertMs): boolean {
  return (timing.rpcMethods ?? []).includes("tools/call") && timing.latencyMs > thresholdMs;
}

/** The closed details of the alert. */
export function latencyAlertDetails(timing: McpRequestTiming, thresholdMs: number): Record<string, unknown> {
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
    threshold_ms: thresholdMs,
    note: "A connector tool call took longer than the connector_slow_call_alert_ms dial. step_latency_ms " +
      "names the slow step. Read the day's mcp_request lines for the rest.",
  };
}

type FirestoreSource = () => Promise<Pick<Firestore, "collection">>;
let firestoreSource: FirestoreSource = async () => (await import("../firestore-client.js")).db;

/** Raise the day's alert for a slow tool call. Returns true only when this call created it. Never throws. */
export async function noteMcpRequestTiming(timing: McpRequestTiming, now: Date = new Date()): Promise<boolean> {
  try {
    const thresholdMs = peekGatewayDials().connectorSlowCallAlertMs;
    if (!isSlowToolCall(timing, thresholdMs)) return false;
    return await raiseAdminAlertOncePerDay(await firestoreSource(), {
      category: CONNECTOR_LATENCY_SLOW_CATEGORY,
      severity: "warn",
      details: latencyAlertDetails(timing, thresholdMs),
    }, now);
  } catch {
    return false;
  }
}

export function __setLatencyAlertFirestoreForTest(source: FirestoreSource): void {
  firestoreSource = source;
}
