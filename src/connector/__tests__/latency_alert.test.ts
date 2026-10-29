/**
 * The connector latency guardrail (MCP_FIXES.md 1.6, node:test): a tools/call over 5 s raises one
 * `connector_latency_slow` admin alert a day, with closed details naming the slow step. A fake
 * Firestore; no network.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { __resetAdminAlertOnceForTest, adminAlertDocId } from "../admin_alert_once.js";
import {
  CONNECTOR_LATENCY_SLOW_CATEGORY,
  SLOW_TOOL_CALL_MS,
  __setLatencyAlertFirestoreForTest,
  isSlowToolCall,
  latencyAlertDetails,
  noteMcpRequestTiming,
} from "../latency_alert.js";

interface Created { path: string; data: Record<string, unknown> }

function fakeDb(existing = new Set<string>()) {
  const created: Created[] = [];
  const db = {
    collection(name: string) {
      return {
        doc(id: string) {
          return {
            create: async (data: Record<string, unknown>) => {
              const path = `${name}/${id}`;
              if (existing.has(path)) throw Object.assign(new Error("exists"), { code: 6 });
              existing.add(path);
              created.push({ path, data });
            },
          };
        },
      };
    },
  };
  return { db: db as never, created };
}

beforeEach(() => __resetAdminAlertOnceForTest());

const slow = { rpcMethods: ["tools/call"], latencyMs: 7970, steps: { auth: 40, rate_limit: 30, return_check: 7300, tool: 666 }, clientClass: "claude" };
const day = new Date("2026-10-29T04:40:16Z");

test("only a tools/call past 5 s is slow", () => {
  assert.equal(SLOW_TOOL_CALL_MS, 5000);
  assert.equal(isSlowToolCall(slow), true);
  assert.equal(isSlowToolCall({ ...slow, latencyMs: 5000 }), false);
  assert.equal(isSlowToolCall({ ...slow, rpcMethods: ["tools/list"] }), false);
  assert.equal(isSlowToolCall({ ...slow, rpcMethods: undefined }), false);
});

test("a slow call raises one alert a day, with the step latencies and a closed class", async () => {
  const { db, created } = fakeDb();
  __setLatencyAlertFirestoreForTest(async () => db);
  assert.equal(await noteMcpRequestTiming(slow, day), true);
  assert.equal(await noteMcpRequestTiming(slow, new Date("2026-10-29T09:00:00Z")), false, "once a day per instance");
  assert.equal(created.length, 1);
  assert.equal(created[0].path, `admin_alerts/${adminAlertDocId(CONNECTOR_LATENCY_SLOW_CATEGORY, day)}`);
  assert.equal(created[0].path, "admin_alerts/connector_latency_slow_2026-10-29");
  assert.equal(created[0].data.category, "connector_latency_slow");
  assert.equal(created[0].data.severity, "warn");
  const details = created[0].data.details as Record<string, unknown>;
  assert.equal(details.latency_ms, 7970);
  assert.deepEqual(details.step_latency_ms, { auth: 40, rate_limit: 30, return_check: 7300, tool: 666 });
  assert.equal(details.client_class, "claude");
  assert.equal(await noteMcpRequestTiming(slow, new Date("2026-10-30T00:00:01Z")), true, "a new UTC day raises again");
});

test("another instance already raised today: ALREADY_EXISTS is success, not a retry", async () => {
  const { db, created } = fakeDb(new Set(["admin_alerts/connector_latency_slow_2026-10-29"]));
  __setLatencyAlertFirestoreForTest(async () => db);
  assert.equal(await noteMcpRequestTiming(slow, day), false);
  assert.equal(created.length, 0);
});

test("a fast call or a non-tool request writes nothing; a broken Firestore never throws", async () => {
  const { db, created } = fakeDb();
  __setLatencyAlertFirestoreForTest(async () => db);
  assert.equal(await noteMcpRequestTiming({ ...slow, latencyMs: 400 }, day), false);
  assert.equal(await noteMcpRequestTiming({ ...slow, rpcMethods: ["initialize"] }, day), false);
  assert.equal(created.length, 0);
  __setLatencyAlertFirestoreForTest(async () => { throw new Error("no firestore"); });
  assert.equal(await noteMcpRequestTiming(slow, day), false);
});

test("details are closed: an unknown class reads unknown, missing steps read null, no ids or strings from the client", () => {
  const details = latencyAlertDetails({ rpcMethods: ["tools/call"], latencyMs: 6000.4, steps: { tool: 5900 }, clientClass: "brad@pelaris.io" });
  assert.equal(details.client_class, "unknown");
  assert.deepEqual(details.step_latency_ms, { auth: null, rate_limit: null, return_check: null, tool: 5900 });
  assert.equal(details.latency_ms, 6000);
  assert.ok(!JSON.stringify(details).includes("@"));
});
