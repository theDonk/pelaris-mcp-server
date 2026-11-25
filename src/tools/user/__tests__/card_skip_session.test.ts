/**
 * card_skip_session (node:test). Run after build.
 *
 * Proves: the card's skip tool takes exactly { sessionId }, strictly; it is app-only
 * (visibility ["app"]) and listed only for a card host; and it calls the app's own skip
 * with the claims' profile. All data is made up.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const captured: Array<Record<string, unknown>> = [];
let nextReply: Record<string, unknown> = { ok: true, result: { sessionId: "session_a_1", status: "skipped", title: "Tempo run", reason: "x", message: "ok" } };
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
const { CARD_SKIP_REASON, CARD_SKIP_TOOL, registerCardSkipSession } = await import("../card_skip_session.js");
const { registerModifyTrainingSession } = await import("../modify_training_session.js");

after(() => { bridgeStub.closeAllConnections?.(); bridgeStub.close(); });

const register = (clientClass: "claude" | "other") => (server: McpServer) =>
  runWithConnectorFacts({ profileId: "profile_test_1", clientClass }, () => {
    // A model tool too, so a text-only host still has a tool list to read.
    registerModifyTrainingSession(server);
    registerCardSkipSession(server);
  });

test("app-only for a card host; not registered for a text-only host", async () => {
  const s = await openToolSession(register("claude"));
  try {
    const card = await s.listedTool(CARD_SKIP_TOOL);
    assert.deepEqual((card?._meta as { ui?: unknown })?.ui, { visibility: ["app"] });
    assert.equal((card?.annotations as Record<string, unknown>).destructiveHint, true);
    assert.equal((card?.annotations as Record<string, unknown>).readOnlyHint, false);
  } finally { await s.close(); }
  const plain = await openToolSession(register("other"));
  try { assert.equal(await plain.listedTool(CARD_SKIP_TOOL), undefined); } finally { await plain.close(); }
});

test("strict input: extra keys and bad ids are refused before any write", async () => {
  const s = await openToolSession(register("claude"));
  try {
    const before = captured.length;
    for (const args of [
      { sessionId: "session_a_1", reason: "typed by someone else" },
      { sessionId: "session_a_1", profileId: "someone_else" },
      { sessionId: "session_a_1", sessionIds: ["a", "b"] },
      { sessionId: "a/b" },
      { sessionId: "" },
      {},
    ]) {
      const r = await s.call(CARD_SKIP_TOOL, args);
      assert.equal(r.isError, true, JSON.stringify(args));
    }
    assert.equal(captured.length, before, "nothing reached the bridge");
  } finally { await s.close(); }
});

test("a valid skip calls the app's own skip with the claims' profile, and names the session it skipped", async () => {
  const s = await openToolSession(register("claude"));
  try {
    const r = await s.call(CARD_SKIP_TOOL, { sessionId: "session_a_1" });
    assert.equal(r.isError, false, r.text);
    const sent = captured[captured.length - 1];
    assert.equal(sent.tool, "skip_session");
    assert.equal(sent.profileId, "profile_test_1");
    assert.deepEqual(sent.input, { sessionId: "session_a_1", reason: CARD_SKIP_REASON });
    const body = JSON.parse(r.text);
    assert.deepEqual(body.skipped, [{ sessionId: "session_a_1" }]);
    assert.equal(typeof body.message, "string");
    const denied = await s.call(CARD_SKIP_TOOL, { sessionId: "session_a_1" }, null);
    assert.equal(denied.isError, true, "no auth, no write");
  } finally { await s.close(); }
});

test("a refused skip (already done, already skipped) comes back as an error, not a success", async () => {
  const s = await openToolSession(register("claude"));
  nextReply = { ok: false, error: "Cannot skip a completed session (session_a_1)" };
  try {
    const r = await s.call(CARD_SKIP_TOOL, { sessionId: "session_a_1" });
    assert.equal(r.isError, true);
    assert.match(r.text, /Cannot skip a completed session/);
  } finally {
    nextReply = { ok: true, result: { sessionId: "session_a_1", status: "skipped" } };
    await s.close();
  }
});
