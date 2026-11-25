/**
 * Host adapter tests (node:test). Run after build.
 *
 * Proves: a host is a card host only by a declared MCP Apps capability or by the one
 * allow-list; an unknown or missing host gets no card work; a text-only host gets no
 * card _meta and no link is minted for it; a card host gets both; the off switch wins.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const { CARD_HOSTS, MCP_APP_MIME_TYPE, MCP_APPS_EXTENSION_ID, TEXT_ONLY_HOST, currentHostProfile, declaresCardCapability, hostProfileFrom } =
  await import("../host.js");
const { CARD_DATA_META_KEY } = await import("../card_shell.js");
const { runWithConnectorFacts } = await import("../../connector/connector_use.js");
const { withSessionCard } = await import("../../tools/user/get_session_details.js");
const { withWeekCard } = await import("../../tools/user/get_active_program.js");
const { withDebriefCard, shapeDebrief } = await import("../../tools/user/get_weekly_debrief.js");
const { withBodyCard } = await import("../../tools/user/get_body_analysis.js");

const CAP = { extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] } } };

test("the allow-list is one constant naming Claude and ChatGPT only", () => {
  assert.deepEqual(Object.keys(CARD_HOSTS).sort(), ["chatgpt", "claude"]);
});

test("a declared capability makes a card host; a listed host name makes one; anything else does not", () => {
  assert.equal(declaresCardCapability(CAP), true);
  assert.equal(declaresCardCapability({ extensions: { [MCP_APPS_EXTENSION_ID]: {} } }), false, "no MIME type named");
  assert.equal(declaresCardCapability({}), false);
  assert.equal(declaresCardCapability(undefined), false);

  const declared = hostProfileFrom({ capabilities: CAP, clientInfo: { name: "Some Host" } }, {});
  assert.equal(declared.supportsCards, true);
  assert.equal(declared.source, "capability");

  assert.equal(hostProfileFrom({ assistantClass: "claude" }, {}).source, "allow-list");
  assert.equal(hostProfileFrom({ assistantClass: "chatgpt" }, {}).supportsCards, true);
  assert.equal(hostProfileFrom({ clientInfo: { name: "claude-ai" } }, {}).supportsCards, true, "clientInfo name");
  for (const assistantClass of ["grok", "gemini", "mistral", "cursor", "other", "unknown", "", null]) {
    const host = hostProfileFrom({ assistantClass }, {});
    assert.equal(host.supportsCards, false, String(assistantClass));
    assert.equal(host.source, "none");
  }
  assert.equal(hostProfileFrom({}, {}).supportsCards, false, "nothing known: no cards");
  assert.equal(hostProfileFrom({ clientInfo: { name: "muse" } }, {}).supportsCards, false);
});

test("the current host comes from the request's connector facts; no facts means no cards", () => {
  assert.equal(currentHostProfile({}), TEXT_ONLY_HOST);
  const host = runWithConnectorFacts({ profileId: "profile_test", clientClass: "chatgpt" }, () => currentHostProfile({}));
  assert.equal(host.name, "chatgpt");
  assert.equal(host.supportsCards, true);
});

function countingMint() {
  const calls: string[] = [];
  const mint = async (route: string) => {
    calls.push(route);
    return "https://example.invalid/one-tap";
  };
  return { calls, mint };
}

const SESSION = {
  title: "Sample",
  blocks: [{ blockType: "strength", semanticType: "main", exercises: [{ exerciseName: "Goblet squat", sets: [{ type: "strength", targetReps: 8, targetWeightKg: 20 }] }] }],
};
const WEEK = {
  today: "2026-11-16",
  programs: [{ kind: "program", weekStartsOn: "2026-11-16", currentWeekSessions: [{ sessionId: "s1", scheduledDate: "2026-11-18", focus: "Tempo run", slotType: "run", isCompleted: false }] }],
};
const DEBRIEF = shapeDebrief({ weekStarting: "2026-11-16", metrics: { sessionsCompleted: 2, sessionsPlanned: 3 }, nextWeekFocus: "Easy week" }, null);
const BODY = { analysis: { scanDate: "2026-11-10", measurements: { waistCm: 80, hipsCm: 95, shouldersCm: 110 } } };

async function allFour(host: Parameters<typeof withBodyCard>[2]) {
  const text = { content: [{ type: "text" as const, text: "{}" }] };
  const { calls, mint } = countingMint();
  const outs = [
    await withSessionCard(text, SESSION, null, mint as never, host),
    await withWeekCard(text, WEEK, null, mint as never, host),
    await withDebriefCard(text, DEBRIEF, null, mint as never, host),
    withBodyCard(text, BODY, host),
  ];
  return { text, calls, outs };
}

test("a text-only host gets no card _meta and no link is minted", async () => {
  for (const host of [TEXT_ONLY_HOST, hostProfileFrom({ assistantClass: "other" }, {})]) {
    const { text, calls, outs } = await allFour(host);
    assert.deepEqual(calls, [], "mint never called");
    for (const out of outs) assert.equal(out, text, "the reply object is returned untouched");
  }
});

test("a card host gets card _meta and the links are minted", async () => {
  const { calls, outs } = await allFour(hostProfileFrom({ assistantClass: "claude" }, {}));
  assert.equal(calls.length, 3, "session, week and debrief each mint one link");
  for (const out of outs.slice(0, 3)) assert.ok(out._meta?.[CARD_DATA_META_KEY], "card data present");
});

test("the off switch wins over a card host", async () => {
  const before = process.env.PELARIS_CARDS;
  process.env.PELARIS_CARDS = "off";
  try {
    const { text, calls, outs } = await allFour(hostProfileFrom({ assistantClass: "claude" }, {}));
    assert.deepEqual(calls, []);
    for (const out of outs) assert.equal(out, text);
  } finally {
    if (before === undefined) delete process.env.PELARIS_CARDS;
    else process.env.PELARIS_CARDS = before;
  }
});
