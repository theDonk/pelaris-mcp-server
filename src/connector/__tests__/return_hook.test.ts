/**
 * B2a C6 (h): the return hook (node:test). The vendored B1R predicates run
 * the shared case table whose expectations wayfinder computes with its real
 * predicates; the hook's outcomes run against a fake bridge.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { readdirSync, readFileSync } from "fs";

import {
  __resetReturnHookCacheForTest,
  BRIDGED_TOOLS,
  KNOWN_TOOLS,
  connectorStampDue,
  directToolCalls,
  GATEWAY_RETURN_PREDICATE_CASES_SHA256,
  hasPlan,
  mayHaveReturnWorkResting,
  runReturnHook,
  type BridgeCall,
} from "../return_hook.js";

const raw = readFileSync(new URL("../../../test_fixtures/gateway_return_predicate_cases.json", import.meta.url), "utf8");
const table = JSON.parse(raw) as {
  may_have_return_work_resting: Array<{ name: string; profile: Record<string, unknown> | null; may_have_return_work_resting: boolean }>;
  connector_stamp_due: Array<{ name: string; profile: Record<string, unknown>; now_ms: number; stamp_minutes: number; connector_stamp_due: boolean }>;
  has_plan: Array<{ name: string; profile: Record<string, unknown> | null; has_plan: boolean }>;
};

test("the predicate case table's canonical digest equals wayfinder's", () => {
  const hash = crypto.createHash("sha256").update(JSON.stringify(JSON.parse(raw)), "utf8").digest("hex");
  assert.equal(hash, GATEWAY_RETURN_PREDICATE_CASES_SHA256);
});

for (const row of table.may_have_return_work_resting) {
  test(`mayHaveReturnWork resting (vendored): ${row.name}`, () => {
    assert.equal(mayHaveReturnWorkResting(row.profile), row.may_have_return_work_resting);
  });
}

for (const row of table.connector_stamp_due) {
  test(`connectorStampDue (vendored): ${row.name}`, () => {
    assert.equal(connectorStampDue(row.profile, row.now_ms, row.stamp_minutes), row.connector_stamp_due);
  });
}

// Connector rev 2.1 (M1): the vendored hasPlan runs wayfinder's own table (the app's profile_cases plus the
// shapes a connector sees). One rule for "does this athlete have a program": generate_program and
// get_onboarding_status both read it from here.
for (const row of table.has_plan) {
  test(`hasPlan (vendored): ${row.name}`, () => {
    assert.equal(hasPlan(row.profile), row.has_plan);
  });
}

test("the has_plan table covers a removed program, a paused one and the manual container", () => {
  const names = table.has_plan.map((r) => r.name);
  for (const needle of ["removed with Remove", "user_paused", "manual container"]) {
    assert.ok(names.some((n) => n.includes(needle)), needle);
  }
  assert.ok(table.has_plan.some((r) => r.has_plan) && table.has_plan.some((r) => !r.has_plan), "both answers are pinned");
});

test("a Firestore Timestamp-like stamp is read through toMillis", () => {
  const now = Date.parse("2026-10-20T06:00:00Z");
  const stamp = { toMillis: () => now - 5 * 60_000 };
  assert.equal(connectorStampDue({ last_connector_use_at: stamp }, now, 60), false);
});

test("only a tools/call of a DIRECT tool gets the hook", () => {
  assert.deepEqual(directToolCalls({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_active_program" } }), ["get_active_program"]);
  assert.deepEqual(directToolCalls({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "log_workout" } }), []);
  assert.deepEqual(directToolCalls({ jsonrpc: "2.0", id: 1, method: "tools/list" }), []);
  assert.deepEqual(directToolCalls({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), []);
  assert.deepEqual(directToolCalls([
    { method: "tools/call", params: { name: "swap_exercise" } },
    { method: "tools/call", params: { name: "get_training_overview" } },
  ]), ["get_training_overview"]);
  assert.deepEqual(directToolCalls(null), []);
  assert.deepEqual(directToolCalls({ method: "tools/call", params: { name: 42 } }), []);
  // A caller-chosen name that is not a registered tool never triggers the hook.
  assert.deepEqual(directToolCalls({ method: "tools/call", params: { name: "not_a_tool" } }), []);
});

test("KNOWN_TOOLS are exactly the user tools index.ts registers", () => {
  const index = readFileSync(new URL("../../../src/index.ts", import.meta.url), "utf8");
  const registered = new Set<string>();
  const dir = new URL("../../../src/tools/user/", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const source = readFileSync(new URL(file, dir), "utf8");
    const fn = /export function (register\w+)\(/.exec(source)?.[1];
    if (!fn || !index.includes(`${fn}(server)`)) continue;
    for (const m of source.matchAll(/registerTool\(\s*"([a-z_]+)"/g)) registered.add(m[1]);
  }
  assert.deepEqual([...registered].sort(), [...KNOWN_TOOLS].sort());
  for (const name of BRIDGED_TOOLS) assert.ok(KNOWN_TOOLS.has(name), name);
});

test("BRIDGED_TOOLS are exactly tools whose source calls the bridge and reads Firestore nowhere", () => {
  const direct = /db\.collection|profileSubcollection|getActiveQueueDocuments|verifySessionOwnership|verifyQueueOwnership/;
  for (const name of BRIDGED_TOOLS) {
    const source = readFileSync(new URL(`../../../src/tools/user/${name}.ts`, import.meta.url), "utf8");
    assert.match(source, /callCoreBridge/, `${name} calls the bridge`);
    assert.doesNotMatch(source, direct, `${name} reads Firestore directly, so it is not bridged`);
  }
});

const RESTED = { active_queues: [{ queue_id: "q_rest", is_active: false, pause_reason: "inactive_21_days", methodology_id: "ai_gen" }], last_connector_use_at: Date.now() };
const RUNNING = { active_queues: [{ queue_id: "q_run", is_active: true }], last_connector_use_at: Date.now() };

function fakeBridge(answer: () => Promise<{ ok: boolean; result?: unknown; error?: string }>): BridgeCall & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (tool: string, profileId: string) => {
    calls.push(`${tool}:${profileId}`);
    return answer();
  }) as unknown as BridgeCall & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const base = { profileId: "uid_gw_hook_0001", stampMinutes: 60, timeoutMs: 200 };

beforeEach(() => __resetReturnHookCacheForTest());

// Hides only the hook's own JSON log lines. It used to swallow EVERY stdout write while it waited,
// which also dropped the test runner's result events for whatever finished in that window (the
// summary then counted a handful of tests instead of the file's hundred; B2a fix pass).
const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const write = process.stdout.write.bind(process.stdout) as (chunk: unknown, ...rest: unknown[]) => boolean;
  (process.stdout as unknown as { write: (chunk: unknown, ...rest: unknown[]) => boolean }).write = (chunk, ...rest) =>
    typeof chunk === "string" && chunk.startsWith('{"severity"') ? true : write(chunk, ...rest);
  try { return await fn(); } finally { (process.stdout as unknown as { write: typeof write }).write = write; }
};

test("rested plan, first call get_active_program: return_check first [today 'No active program', new resumed]", async () => {
  const bridge = fakeBridge(async () => ({ ok: true, result: { resumed_queue_ids: ["q_rest"] } }));
  const outcome = await quietly(() => runReturnHook({ ...base, profileData: RESTED, tools: ["get_active_program"], bridge }));
  assert.equal(outcome, "resumed");
  assert.deepEqual(bridge.calls, ["return_check:uid_gw_hook_0001"]);
});

test("tools/list on a rested profile: no bridge call", async () => {
  const bridge = fakeBridge(async () => ({ ok: true, result: { resumed_queue_ids: [] } }));
  const outcome = await runReturnHook({ ...base, profileData: RESTED, tools: directToolCalls({ method: "tools/list" }), bridge });
  assert.equal(outcome, "not_direct");
  assert.deepEqual(bridge.calls, []);
});

test("a running plan with a fresh stamp: no bridge call", async () => {
  const bridge = fakeBridge(async () => ({ ok: true, result: { resumed_queue_ids: [] } }));
  assert.equal(await runReturnHook({ ...base, profileData: RUNNING, tools: ["get_active_program"], bridge }), "no_work");
  assert.deepEqual(bridge.calls, []);
});

test("a due stamp calls return_check (its one writer stamps); the gateway writes nothing itself", async () => {
  const bridge = fakeBridge(async () => ({ ok: true, result: { resumed_queue_ids: [] } }));
  const stale = { ...RUNNING, last_connector_use_at: Date.now() - 2 * 3600_000 };
  assert.equal(await runReturnHook({ ...base, profileData: stale, tools: ["get_training_overview"], bridge }), "stamp_async");
  assert.equal(bridge.calls.length, 1);
});

// ── Only a possible resume is awaited ────────────────────────────────────────

test("stamp only (running plan, stamp due): the tool does not wait, even for a slow bridge", async () => {
  const slow = fakeBridge(() => new Promise((r) => setTimeout(() => r({ ok: true, result: { resumed_queue_ids: [] } }), 300)));
  const stale = { ...RUNNING, last_connector_use_at: Date.now() - 2 * 3600_000 };
  const t0 = Date.now();
  const started = Date.now();
  assert.equal(await runReturnHook({ ...base, timeoutMs: 5000, profileData: stale, tools: ["get_training_overview"], bridge: slow, nowMs: t0 }), "stamp_async");
  assert.ok(Date.now() - started < 100, "returned before the bridge answered");
  assert.equal(await runReturnHook({ ...base, profileData: stale, tools: ["get_training_overview"], bridge: slow, nowMs: t0 + 1000 }), "stamp_async");
  assert.equal(slow.calls.length, 1, "one background call per profile at a time");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await runReturnHook({ ...base, profileData: stale, tools: ["get_training_overview"], bridge: slow, nowMs: t0 + 2000 }), "cached_empty", "the empty answer is cached when it lands");
});

test("stamp only: a background failure still backs off, and never surfaces as an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const broken = fakeBridge(async () => { throw new Error("fetch failed"); });
    const stale = { ...RUNNING, last_connector_use_at: Date.now() - 2 * 3600_000 };
    const t0 = Date.now();
    assert.equal(await quietly(async () => {
      const outcome = await runReturnHook({ ...base, profileData: stale, tools: ["get_training_overview"], bridge: broken, nowMs: t0 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return outcome;
    }), "stamp_async");
    assert.equal(await runReturnHook({ ...base, profileData: stale, tools: ["get_training_overview"], bridge: broken, nowMs: t0 + 60_000 }), "backoff");
    // A failed background stamp never blocks the awaited resume of a rested plan.
    const resume = fakeBridge(async () => ({ ok: true, result: { resumed_queue_ids: ["q_rest"] } }));
    assert.equal(await quietly(() => runReturnHook({ ...base, profileData: RESTED, tools: ["get_active_program"], bridge: resume, nowMs: t0 + 61_000 })), "resumed");
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a possible resume is still awaited before the tool reads", async () => {
  const slowResume = fakeBridge(() => new Promise((r) => setTimeout(() => r({ ok: true, result: { resumed_queue_ids: ["q_rest"] } }), 120)));
  const started = Date.now();
  const outcome = await quietly(() => runReturnHook({ ...base, timeoutMs: 2000, profileData: RESTED, tools: ["get_active_program"], bridge: slowResume }));
  assert.equal(outcome, "resumed");
  assert.ok(Date.now() - started >= 100, "waited for the resume");
});

test("an empty answer is cached per profile for the stamp minutes", async () => {
  const bridge = fakeBridge(async () => ({ ok: true, result: { resumed_queue_ids: [] } }));
  const t0 = Date.now();
  assert.equal(await runReturnHook({ ...base, profileData: RESTED, tools: ["get_active_program"], bridge, nowMs: t0 }), "empty");
  assert.equal(await runReturnHook({ ...base, profileData: RESTED, tools: ["get_active_program"], bridge, nowMs: t0 + 30 * 60_000 }), "cached_empty");
  assert.equal(await runReturnHook({ ...base, profileData: RESTED, tools: ["get_active_program"], bridge, nowMs: t0 + 61 * 60_000 }), "empty");
  assert.equal(bridge.calls.length, 2);
});

test("a timeout runs the tool as today, bounded by the dial", async () => {
  const bridge = fakeBridge(() => new Promise((r) => setTimeout(() => r({ ok: true, result: { resumed_queue_ids: [] } }), 2000)));
  const started = Date.now();
  const outcome = await quietly(() => runReturnHook({ ...base, timeoutMs: 100, profileData: RESTED, tools: ["get_active_program"], bridge }));
  assert.equal(outcome, "timed_out");
  assert.ok(Date.now() - started < 1000);
});

test("a bridge refusal (B1R not deployed yet: tool_not_allowed) runs the tool as today and backs off five minutes", async () => {
  const refused = fakeBridge(async () => ({ ok: false, error: "tool_not_allowed" }));
  const t0 = Date.now();
  assert.equal(await quietly(() => runReturnHook({ ...base, profileData: RESTED, tools: ["get_active_program"], bridge: refused, nowMs: t0 })), "failed");
  assert.equal(await quietly(() => runReturnHook({ ...base, profileData: RESTED, tools: ["get_active_program"], bridge: refused, nowMs: t0 + 60_000 })), "backoff");
  assert.equal(await quietly(() => runReturnHook({ ...base, profileData: RESTED, tools: ["get_active_program"], bridge: refused, nowMs: t0 + 6 * 60_000 })), "failed");
  assert.equal(refused.calls.length, 2);
});

test("a thrown bridge call also runs the tool as today", async () => {
  const thrown = fakeBridge(async () => { throw new Error("fetch failed"); });
  assert.equal(await quietly(() => runReturnHook({ ...base, profileData: RESTED, tools: ["get_active_program"], bridge: thrown })), "failed");
});

// ── B2a fix pass, CR-10 and CR-11 ───────────────────────────────────────────

test("CR-10: a malformed bridge reply (null, a string, no envelope) is a failure, never a throw", async () => {
  for (const reply of [null, undefined, "ok", 7]) {
    __resetReturnHookCacheForTest();
    const bridge = fakeBridge((async () => reply) as never);
    assert.equal(
      await runReturnHook({ ...base, profileData: RESTED, tools: ["get_active_program"], bridge }),
      "failed",
      String(reply),
    );
  }
});

test("CR-10: a malformed reply that arrives AFTER the timeout cannot become an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const bridge = fakeBridge(() => new Promise((resolve) => setTimeout(() => resolve(null as never), 150)));
    assert.equal(await runReturnHook({ ...base, timeoutMs: 30, profileData: RESTED, tools: ["get_active_program"], bridge }), "timed_out");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("CR-11: a timeout backs off like a failure: no new bridge call for five minutes, then it tries again", async () => {
  const slow = fakeBridge(() => new Promise((resolve) => setTimeout(() => resolve({ ok: true, result: { resumed_queue_ids: [] } }), 300)));
  const t0 = Date.now();
  assert.equal(await runReturnHook({ ...base, timeoutMs: 20, profileData: RESTED, tools: ["get_active_program"], bridge: slow, nowMs: t0 }), "timed_out");
  assert.equal(await runReturnHook({ ...base, timeoutMs: 20, profileData: RESTED, tools: ["get_active_program"], bridge: slow, nowMs: t0 + 60_000 }), "backoff");
  assert.equal(slow.calls.length, 1, "no second long-running bridge call while backing off");
  assert.equal(await runReturnHook({ ...base, timeoutMs: 20, profileData: RESTED, tools: ["get_active_program"], bridge: slow, nowMs: t0 + 6 * 60_000 }), "timed_out");
  assert.equal(slow.calls.length, 2);
  await new Promise((resolve) => setTimeout(resolve, 400));
});

test("CR-10: a bridge that throws synchronously is a failure too", async () => {
  const bridge = (() => { throw new Error("sync boom"); }) as unknown as BridgeCall;
  assert.equal(await runReturnHook({ ...base, profileData: RESTED, tools: ["get_active_program"], bridge }), "failed");
});
