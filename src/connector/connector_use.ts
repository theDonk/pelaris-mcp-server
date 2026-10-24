/**
 * `connector_use`: presence through ChatGPT or Claude (Pelaris 1.4 B2a lane C,
 * C6 d; FL-9 1.6 / I4; panel P3-M2 = P2-4).
 *
 * After a successful OAuth tool call the gateway prints one closed line,
 * `{event: "connector_use", profileId, client_class, day}`, separate from
 * `tool_call` (which stays pseudonym-only). `client_class` is the token doc's
 * stored `assistant_class` (lane A classifies it once at consent from the
 * validated redirect host), `unknown` for a token minted before that field
 * existed. `day` is the UTC day. Never for admin-authed calls, and never when
 * the ownership check could not read Firestore (the facts are then absent).
 * Tool handlers already call `logToolCall`; it calls `noteConnectorToolSuccess`
 * here, which reads the request's facts from AsyncLocalStorage.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import type { AssistantClass } from "./token_access.js";

export interface ConnectorFacts {
  profileId: string;
  clientClass: AssistantClass | "unknown";
}

const store = new AsyncLocalStorage<ConnectorFacts | null>();

export function runWithConnectorFacts<T>(facts: ConnectorFacts | null, fn: () => T): T {
  return store.run(facts, fn);
}

export function currentConnectorFacts(): ConnectorFacts | null {
  return store.getStore() ?? null;
}

export function connectorUseLine(facts: ConnectorFacts, now: Date = new Date()): {
  severity: "INFO";
  event: "connector_use";
  profileId: string;
  client_class: string;
  day: string;
} {
  return {
    severity: "INFO",
    event: "connector_use",
    profileId: facts.profileId,
    client_class: facts.clientClass,
    day: now.toISOString().slice(0, 10),
  };
}

/** One `connector_use` line for a successful tool call under OAuth facts. */
export function noteConnectorToolSuccess(now: Date = new Date()): void {
  const facts = currentConnectorFacts();
  if (!facts) return;
  process.stdout.write(JSON.stringify(connectorUseLine(facts, now)) + "\n");
}
