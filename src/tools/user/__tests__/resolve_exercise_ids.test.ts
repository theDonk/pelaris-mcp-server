/**
 * Unit + contract tests for the resolve_exercise_ids MCP tool (node:test, no
 * extra dependencies). Run after build: node --test dist/tools/user/__tests__/
 *
 * The bridge is stubbed with a local HTTP server (emulator mode: plain fetch,
 * no ID token), so the tests prove the wire contract: profileId comes from
 * validated claims only, queries pass through verbatim, the bridge result is
 * returned verbatim, and bridge failures surface as isError + errorDetail
 * JSON instead of raw throws.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { McpTokenClaims } from "../../../auth.js";

// The bridge client reads CF_BASE_URL and FIRESTORE_EMULATOR_HOST at module
// load, so the stub server must be listening before the tool module imports.
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
    // connection: close keeps undici from pooling the socket, so the test
    // process exits promptly once the server closes.
    res.writeHead(200, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify(respondWith));
  });
});
await new Promise<void>((resolve) => bridgeStub.listen(0, "127.0.0.1", resolve));
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.CF_BASE_URL = `http://127.0.0.1:${(bridgeStub.address() as AddressInfo).port}`;

const {
  RESOLVE_EXERCISE_IDS_DESCRIPTION,
  registerResolveExerciseIds,
  resolveExerciseIdsQueriesField,
} = await import("../resolve_exercise_ids.js");
const { runWithAuth } = await import("../../../request-context.js");

after(() => {
  bridgeStub.closeAllConnections?.();
  bridgeStub.close();
});

const claims: McpTokenClaims = {
  sub: "pseudonym_test",
  scope: "training:read",
  platform: "test",
  profile_id: "profile_test_1",
  exp: 0,
  iat: 0,
};

interface CapturedTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  handler: (params: { queries: string[] }) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function captureRegistration(): CapturedTool {
  let captured: CapturedTool | null = null;
  const fakeServer = {
    tool: (...args: unknown[]) => {
      captured = {
        name: args[0] as string,
        description: args[1] as string,
        schema: args[2] as Record<string, unknown>,
        annotations: args[3] as Record<string, unknown>,
        handler: args[4] as CapturedTool["handler"],
      };
    },
  };
  registerResolveExerciseIds(fakeServer as unknown as Parameters<typeof registerResolveExerciseIds>[0]);
  assert.ok(captured, "tool registration captured");
  return captured;
}

test("registers with the exact name, read-only annotations, and a teaching description", () => {
  const tool = captureRegistration();
  assert.equal(tool.name, "resolve_exercise_ids");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.equal(tool.description, RESOLVE_EXERCISE_IDS_DESCRIPTION);
  assert.ok(tool.description.includes("exercise_id"), "description teaches the id vocabulary");
  assert.ok(tool.description.includes("exerciseId"), "description teaches the write-tool field name");
  assert.ok("queries" in tool.schema);
});

test("queries field enforces 1-20 movement names with sane lengths", () => {
  assert.deepEqual(resolveExerciseIdsQueriesField.parse(["Barbell Bench Press"]), ["Barbell Bench Press"]);
  const twenty = Array.from({ length: 20 }, (_, i) => `Movement ${i + 1}`);
  assert.deepEqual(resolveExerciseIdsQueriesField.parse(twenty), twenty);
  assert.throws(() => resolveExerciseIdsQueriesField.parse([]));
  assert.throws(() => resolveExerciseIdsQueriesField.parse(Array.from({ length: 21 }, () => "Row")));
  assert.throws(() => resolveExerciseIdsQueriesField.parse([""]));
  assert.throws(() => resolveExerciseIdsQueriesField.parse(["x".repeat(201)]));
});

test("denies without auth context and without training:read scope, never touching the bridge", async () => {
  const tool = captureRegistration();
  const callsBefore = capturedRequests.length;

  const noAuth = await tool.handler({ queries: ["Bench Press"] });
  assert.equal(noAuth.isError, true);
  assert.equal(noAuth.content[0].text, "Error: training:read scope required");

  const wrongScope = await runWithAuth({ ...claims, scope: "training:write" }, () =>
    tool.handler({ queries: ["Bench Press"] }),
  );
  assert.equal(wrongScope.isError, true);
  assert.equal(wrongScope.content[0].text, "Error: training:read scope required");

  assert.equal(capturedRequests.length, callsBefore, "bridge must not be called on scope denial");
});

test("passes profileId from claims and queries verbatim; returns the bridge result", async () => {
  const tool = captureRegistration();
  respondWith = {
    ok: true,
    tool: "resolve_exercise_ids",
    result: {
      results: [
        {
          query: "bench press",
          match: { id: "wger_0192", name: "Barbell Bench Press", isCanonical: true, status: "approved" },
        },
        { query: "mystery movement", match: null, reason: "no_match" },
      ],
    },
  };

  const response = await runWithAuth(claims, () =>
    tool.handler({ queries: ["bench press", "mystery movement"] }),
  );
  assert.notEqual(response.isError, true);

  const request = capturedRequests.at(-1);
  assert.ok(request);
  assert.equal(request.tool, "resolve_exercise_ids");
  assert.equal(request.profileId, "profile_test_1");
  assert.deepEqual((request.input as Record<string, unknown>).queries, ["bench press", "mystery movement"]);

  const parsed = JSON.parse(response.content[0].text) as Record<string, unknown>;
  assert.deepEqual(parsed, respondWith.result);
});

test("maps a failed bridge envelope to isError with errorDetail JSON", async () => {
  const tool = captureRegistration();
  respondWith = {
    ok: false,
    tool: "resolve_exercise_ids",
    error: "resolver unavailable",
    errorDetail: { retryable: true },
  };

  const response = await runWithAuth(claims, () => tool.handler({ queries: ["bench press"] }));
  assert.equal(response.isError, true);
  const [first, second] = response.content[0].text.split("\n");
  assert.equal(first, "Error resolving exercise ids: resolver unavailable");
  assert.deepEqual(JSON.parse(second), { retryable: true });
});

test("transport failure surfaces as isError, never a raw throw", async () => {
  const tool = captureRegistration();
  destroyNextConnection = true;

  const response = await runWithAuth(claims, () => tool.handler({ queries: ["bench press"] }));
  assert.equal(response.isError, true);
  assert.ok(response.content[0].text.startsWith("Error: "));
});
