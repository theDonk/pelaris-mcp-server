/**
 * Protocol-level request log (MCP_FIXES.md §1.4 step 1b, node:test): the description is
 * allow-list only, mirrors the SDK's version negotiation, caps and cleans client-controlled
 * strings, and the writer never throws into the request path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

import { describeMcpRequest, logMcpRequest } from "../logger.js";

const describe = (body: unknown, headers: Record<string, unknown> = {}) =>
  describeMcpRequest(body, headers, SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION);

test("initialize: records the requested version, client identity and the version the SDK answers", () => {
  const d = describe(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "Google", version: "1.0" }, capabilities: {} } },
    { accept: "application/json, text/event-stream" },
  );
  assert.deepEqual(d.rpcMethods, ["initialize"]);
  assert.equal(d.clientProtocolVersion, "2025-06-18");
  assert.equal(d.negotiatedProtocolVersion, "2025-06-18");
  assert.equal(d.clientName, "Google");
  assert.equal(d.clientVersion, "1.0");
  assert.equal(d.accept, "application/json, text/event-stream");
});

test("an unsupported requested version negotiates to the SDK's latest", () => {
  const d = describe({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28" } });
  assert.equal(d.clientProtocolVersion, "2026-07-28");
  assert.equal(d.negotiatedProtocolVersion, LATEST_PROTOCOL_VERSION);
});

test("tools/call: only the method name, never arguments, results or ids", () => {
  const d = describe(
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "log_workout", arguments: { notes: "secret@example.com" } } },
    { "mcp-protocol-version": "2025-11-25", authorization: "Bearer abc.def.ghi" },
  );
  assert.deepEqual(d.rpcMethods, ["tools/call"]);
  assert.equal(d.mcpProtocolVersionHeader, "2025-11-25");
  const line = JSON.stringify(d);
  assert.ok(!line.includes("log_workout"), "tool name is not in the protocol line (logToolCall records it)");
  assert.ok(!line.includes("secret@example.com"), "arguments never logged");
  assert.ok(!line.includes("Bearer"), "Authorization never logged");
});

test("batches, notifications and junk are described without throwing", () => {
  const d = describe([{ jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, result: {} }, null, 42]);
  assert.deepEqual(d.rpcMethods, ["notifications/initialized", "(response)"]);
  assert.deepEqual(describe(undefined).rpcMethods, []);
  assert.deepEqual(describe("not json").rpcMethods, []);
});

test("client-controlled strings are capped and stripped of control characters", () => {
  const d = describe(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "x", clientInfo: { name: "Evil\nInjected\u0000" + "a".repeat(500) } } },
    { accept: ["a", "b"] },
  );
  assert.ok(d.clientName && d.clientName.length <= 120);
  assert.ok(!/[\n\u0000]/.test(d.clientName ?? ""));
  assert.equal(d.accept, "a,b");
});

test("logMcpRequest never throws, even when stdout fails", () => {
  const original = process.stdout.write;
  (process.stdout as unknown as { write: () => never }).write = () => {
    throw new Error("stdout broken");
  };
  try {
    assert.doesNotThrow(() => logMcpRequest({ requestId: "r", httpMethod: "POST", status: 200, durationMs: 1 }));
  } finally {
    process.stdout.write = original;
  }
});
