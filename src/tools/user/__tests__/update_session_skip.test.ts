/**
 * update_session with status "skipped" (node:test). Run after build.
 *
 * Proves: a skip asked in words goes to the app's own skip with the claims' profile and
 * the athlete's reason; a skip mixed with other changes is refused before any write; and
 * the other status paths are untouched. All data is made up.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const captured: Array<Record<string, unknown>> = [];
let nextReply: Record<string, unknown> = { ok: true, result: { sessionId: "session_a_1", status: "skipped", title: "Tempo run" } };
const bridgeStub = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => { data += c; });
  req.on("end", () => {
    captured.push(JSON.parse(data) as Record<string, unknown>);
    res.writeHead(200, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify(nextReply));
  });
});
await new Promise<void>((resolve) => bridgeStub.listen(0, "127.0.0.1", resolve));
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:1";
process.env.CF_BASE_URL = `http://127.0.0.1:${(bridgeStub.address() as AddressInfo).port}`;

const { openToolSession } = await import("./mcp_harness.js");
const { runWithConnectorFacts } = await import("../../../connector/connector_use.js");
const { registerUpdateSession } = await import("../update_session.js");
const { SKIP_REASON_NOT_GIVEN, buildUpdateSessionSkipInput, fieldsNotAllowedWithSkip, isSkipRequest } =
  await import("../session_modify_mapping.js");

after(() => { bridgeStub.closeAllConnections?.(); bridgeStub.close(); });

const register = (server: McpServer) =>
  runWithConnectorFacts({ profileId: "profile_test_1", clientClass: "other" }, () => registerUpdateSession(server));

test("mapping: the athlete's words are the reason; no words means the plain marker", () => {
  assert.equal(isSkipRequest({ sessionId: "s", status: "skipped" }), true);
  assert.equal(isSkipRequest({ sessionId: "s", status: "completed" }), false);
  assert.deepEqual(buildUpdateSessionSkipInput({ sessionId: "s", status: "skipped", feedbackNote: "  Sore calf  " }), { sessionId: "s", reason: "Sore calf" });
  assert.deepEqual(buildUpdateSessionSkipInput({ sessionId: "s", status: "skipped" }), { sessionId: "s", reason: SKIP_REASON_NOT_GIVEN });
  assert.deepEqual(fieldsNotAllowedWithSkip({ sessionId: "s", status: "skipped", feedbackNote: "x" }), []);
  assert.deepEqual(fieldsNotAllowedWithSkip({ sessionId: "s", status: "skipped", title: "New", rpe: 5 }), ["title", "rpe"]);
});

test("a skip goes to the app's own skip with the claims' profile and the reason", async () => {
  const s = await openToolSession(register);
  try {
    const r = await s.call("update_session", { sessionId: "session_a_1", status: "skipped", feedbackNote: "Sore calf" });
    assert.equal(r.isError, false, r.text);
    const sent = captured[captured.length - 1];
    assert.equal(sent.tool, "skip_session");
    assert.equal(sent.profileId, "profile_test_1");
    assert.deepEqual(sent.input, { sessionId: "session_a_1", reason: "Sore calf" });
    const body = JSON.parse(r.text);
    assert.equal(body.status, "skipped");
    assert.equal(body.sessionId, "session_a_1");
    assert.deepEqual(body.updatedFields, ["status"]);
  } finally { await s.close(); }
});

test("a skip mixed with other changes is refused before any write", async () => {
  const s = await openToolSession(register);
  try {
    const before = captured.length;
    const r = await s.call("update_session", { sessionId: "session_a_1", status: "skipped", scheduledDate: "2026-11-27", durationMinutes: 30 });
    assert.equal(r.isError, true);
    assert.match(r.text, /cannot be combined with durationMinutes, scheduledDate/);
    assert.equal(captured.length, before, "nothing reached the bridge");
  } finally { await s.close(); }
});

test("a refused skip comes back as an error; a plain status change still takes the metadata path", async () => {
  const s = await openToolSession(register);
  try {
    nextReply = { ok: false, error: "Session session_a_1 is already skipped" };
    const refused = await s.call("update_session", { sessionId: "session_a_1", status: "skipped" });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /already skipped/);
    nextReply = { ok: true, result: { sessionId: "session_a_1", updatedFields: ["status"] } };
    const planned = await s.call("update_session", { sessionId: "session_a_1", status: "planned" });
    assert.equal(planned.isError, false, planned.text);
    const sent = captured[captured.length - 1];
    assert.equal(sent.tool, "modify_session");
    assert.deepEqual(sent.input, { type: "metadata", sessionId: "session_a_1", status: "planned" });
  } finally { await s.close(); }
});
