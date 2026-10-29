/**
 * Contract tests for record_benchmark over the core bridge. node:test; run
 * after build.
 *
 * The tool calls the core's update_athlete (type "benchmark"), which resolves
 * the canonical benchmark id and refuses a value whose unit does not fit.
 * These tests prove the wire contract: profileId from the claims only, `type`
 * pinned, the core's refusal explained, and no direct-write fallback.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { McpTokenClaims } from "../../../auth.js";

const capturedRequests: Array<Record<string, unknown>> = [];
let respondWith: Record<string, unknown> = {};
let destroyNextConnection = false;

const bridgeStub = http.createServer((req, res) => {
  if (destroyNextConnection) {
    destroyNextConnection = false;
    req.socket.destroy();
    return;
  }
  let data = "";
  req.on("data", (chunk) => {
    data += chunk;
  });
  req.on("end", () => {
    capturedRequests.push(JSON.parse(data) as Record<string, unknown>);
    res.writeHead(200, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify(respondWith));
  });
});
await new Promise<void>((resolve) => bridgeStub.listen(0, "127.0.0.1", resolve));
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:1";
process.env.CF_BASE_URL = `http://127.0.0.1:${(bridgeStub.address() as AddressInfo).port}`;

const { registerRecordBenchmark, UNIT_MISMATCH_TEXT } = await import("../record_benchmark.js");
const { runWithAuth } = await import("../../../request-context.js");

after(() => {
  bridgeStub.closeAllConnections?.();
  bridgeStub.close();
});

const claims: McpTokenClaims = {
  sub: "pseudonym_test",
  scope: "health:write training:write",
  platform: "test",
  profile_id: "profile_test_1",
  exp: 0,
  iat: 0,
};

type Handler = (params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

function handler(): Handler {
  let captured: Handler | null = null;
  const fakeServer = {
    registerTool: (_name: string, _config: unknown, h: unknown) => {
      captured = h as Handler;
    },
  };
  registerRecordBenchmark(fakeServer as never);
  assert.ok(captured, "tool registration captured");
  return captured;
}

test("record_benchmark denies without health:write, never touching the bridge", async () => {
  const before = capturedRequests.length;
  const noAuth = await handler()({ benchmarkName: "Bench Press 1RM", value: 100 });
  assert.equal(noAuth.isError, true);
  assert.equal(noAuth.content[0].text, "Error: health:write scope required");
  assert.equal(capturedRequests.length, before);
});

test("record_benchmark: the bridge gets update_athlete with type benchmark pinned and the claims' profile id only", async () => {
  respondWith = {
    ok: true,
    tool: "update_athlete",
    result: {
      type: "benchmark", benchmarkId: "bench_1rm", previousValue: 100, newValue: 102.5,
      improvementDirection: "higher", change: "improved", message: "Benchmark \"bench_1rm\" updated: 100 → 102.5 kg",
    },
  };
  const response = await runWithAuth(claims, () =>
    handler()({ benchmarkName: "Bench Press 1RM", value: 102.5, unit: "kg", type: "profile", profileId: "someone_else" }),
  );
  assert.notEqual(response.isError, true);
  const request = capturedRequests.at(-1) as { tool: string; profileId: string; input: Record<string, unknown> };
  assert.equal(request.tool, "update_athlete");
  assert.equal(request.profileId, "profile_test_1");
  assert.deepEqual(request.input, { type: "benchmark", benchmarkName: "Bench Press 1RM", value: 102.5, unit: "kg" });
  const parsed = JSON.parse(response.content[0].text) as Record<string, unknown>;
  // The canonical id comes from the core, not from the typed name.
  assert.equal(parsed.benchmarkId, "bench_1rm");
  assert.equal(parsed.status, "updated");
  assert.equal(parsed.change, "improved");
});

test("record_benchmark: the core's unit refusal is explained and nothing else is tried", async () => {
  respondWith = { ok: false, tool: "update_athlete", error: "benchmark_unit_mismatch" };
  const before = capturedRequests.length;
  const response = await runWithAuth(claims, () => handler()({ benchmarkName: "Bench Press 1RM", value: 120, unit: "sec" }));
  assert.equal(response.isError, true);
  assert.equal(response.content[0].text, UNIT_MISMATCH_TEXT);
  assert.equal(capturedRequests.length, before + 1, "one bridge call, no direct-write fallback");
});

test("record_benchmark: a transport failure is an error result, and nothing is written directly", async () => {
  destroyNextConnection = true;
  const response = await runWithAuth(claims, () => handler()({ benchmarkName: "Bench Press 1RM", value: 100, unit: "kg" }));
  assert.equal(response.isError, true);
  assert.ok(response.content[0].text.startsWith("Error: "));
});
