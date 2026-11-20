/**
 * card_reschedule_session (node:test). Run after build.
 *
 * Proves: the card's move tool takes exactly { sessionId, newDate }, strictly; it is
 * app-only (visibility ["app"]) and listed only for a card host; it calls the same
 * reschedule path as modify_training_session with the claims' profile; and
 * modify_training_session is no longer callable from a card.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const captured: Array<Record<string, unknown>> = [];
const bridgeStub = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => { data += c; });
  req.on("end", () => {
    captured.push(JSON.parse(data) as Record<string, unknown>);
    res.writeHead(200, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify({ ok: true, result: { type: "reschedule_many", moved: [{ sessionId: "session_a_1", newDate: "2026-11-27" }], message: "Moved 1 session" } }));
  });
});
await new Promise<void>((resolve) => bridgeStub.listen(0, "127.0.0.1", resolve));
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:1";
process.env.CF_BASE_URL = `http://127.0.0.1:${(bridgeStub.address() as AddressInfo).port}`;

const { openToolSession } = await import("./mcp_harness.js");
const { runWithConnectorFacts } = await import("../../../connector/connector_use.js");
const { CARD_RESCHEDULE_TOOL, isCalendarDay, registerCardRescheduleSession, registerModifyTrainingSession } =
  await import("../modify_training_session.js");

after(() => { bridgeStub.closeAllConnections?.(); bridgeStub.close(); });

const both = (clientClass: "claude" | "other") => (server: McpServer) =>
  runWithConnectorFacts({ profileId: "profile_test_1", clientClass }, () => {
    registerModifyTrainingSession(server);
    registerCardRescheduleSession(server);
  });

test("app-only for a card host; not registered for a text-only host; the model tool is not card-callable", async () => {
  const s = await openToolSession(both("claude"));
  try {
    const card = await s.listedTool(CARD_RESCHEDULE_TOOL);
    assert.deepEqual((card?._meta as { ui?: unknown })?.ui, { visibility: ["app"] });
    assert.equal((card?.annotations as Record<string, unknown>).destructiveHint, true);
    assert.equal((await s.listedTool("modify_training_session"))?._meta, undefined);
  } finally { await s.close(); }
  const plain = await openToolSession(both("other"));
  try { assert.equal(await plain.listedTool(CARD_RESCHEDULE_TOOL), undefined); } finally { await plain.close(); }
});

test("strict input: extra operations and bad ids or dates are refused before any write", async () => {
  const s = await openToolSession(both("claude"));
  try {
    const before = captured.length;
    for (const args of [
      { sessionId: "session_a_1", newDate: "2026-11-27", reduceVolume: 0.5 },
      { sessionId: "session_a_1", newDate: "2026-11-27", rescheduleSessions: [{ sessionId: "x", newDate: "2026-11-28" }] },
      { sessionId: "session_a_1", newDate: "2026-11-27", profileId: "someone_else" },
      { sessionId: "a/b", newDate: "2026-11-27" },
      { sessionId: "session_a_1", newDate: "2026-02-30" },
      { sessionId: "session_a_1", newDate: "27/11/2026" },
      { sessionId: "session_a_1" },
    ]) {
      const r = await s.call(CARD_RESCHEDULE_TOOL, args);
      assert.equal(r.isError, true, JSON.stringify(args));
    }
    assert.equal(captured.length, before, "nothing reached the bridge");
    assert.equal(isCalendarDay("2026-11-27"), true);
    assert.equal(isCalendarDay("2026-13-01"), false);
  } finally { await s.close(); }
});

test("a valid move goes through the shared reschedule path with the claims' profile, same reply shape", async () => {
  const s = await openToolSession(both("claude"));
  try {
    const r = await s.call(CARD_RESCHEDULE_TOOL, { sessionId: "session_a_1", newDate: "2026-11-27" });
    assert.equal(r.isError, false, r.text);
    const sent = captured[captured.length - 1];
    assert.equal(sent.profileId, "profile_test_1");
    assert.deepEqual(sent.input, { type: "reschedule_many", moves: [{ sessionId: "session_a_1", newDate: "2026-11-27" }] });
    const body = JSON.parse(r.text);
    for (const k of ["moved", "skipped", "needsAthlete", "failed", "message"]) assert.ok(k in body, k);
    const denied = await s.call(CARD_RESCHEDULE_TOOL, { sessionId: "session_a_1", newDate: "2026-11-27" }, null);
    assert.equal(denied.isError, true, "no auth, no write");
  } finally { await s.close(); }
});
