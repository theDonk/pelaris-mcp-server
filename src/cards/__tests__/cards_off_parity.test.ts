/**
 * Cards off, or a text-only host: the model-visible output of the five touched tools is
 * the documented contract, on purpose (node:test). Run after build.
 *
 * For each card tool, with the switch off and for a text-only host: the reply object is
 * returned untouched (same text, no `_meta`), no signed link is minted, and the tool is
 * listed as a plain tool. `history` (get_body_analysis) and `durationMinutes`
 * (get_active_program) are deliberate tool fields for the assistant as well as the card,
 * so they stay in the contract whatever the switch says. modify_training_session is
 * listed with `idempotentHint: false` and no card `_meta`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const { TEXT_ONLY_HOST, hostProfileFrom } = await import("../host.js");
const { runWithConnectorFacts } = await import("../../connector/connector_use.js");
const { withSessionCard, registerGetSessionDetails } = await import("../../tools/user/get_session_details.js");
const { withWeekCard, registerGetActiveProgram } = await import("../../tools/user/get_active_program.js");
const { withDebriefCard, shapeDebrief, registerGetWeeklyDebrief } = await import("../../tools/user/get_weekly_debrief.js");
const { withBodyCard, bodyAnalysisFromCore, registerGetBodyAnalysis } = await import("../../tools/user/get_body_analysis.js");
const { registerModifyTrainingSession } = await import("../../tools/user/modify_training_session.js");

type Host = Parameters<typeof withBodyCard>[2];
const CLAUDE = hostProfileFrom({ assistantClass: "claude" }, {});

/** The two ways a reply must come out plain: switch off (card host), or a text-only host. */
async function eachPlainGate(fn: (host: Host) => Promise<void>): Promise<void> {
  const before = process.env.PELARIS_CARDS;
  process.env.PELARIS_CARDS = "off";
  try {
    await fn(CLAUDE);
  } finally {
    if (before === undefined) delete process.env.PELARIS_CARDS;
    else process.env.PELARIS_CARDS = before;
  }
  await fn(TEXT_ONLY_HOST);
  await fn(hostProfileFrom({ assistantClass: "other" }, {}));
}

function countingMint() {
  const calls: string[] = [];
  return { calls, mint: (async (route: string) => { calls.push(route); return "https://example.invalid/one-tap"; }) as never };
}

const text = (body: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(body) }] });

function assertPlain(out: unknown, reply: unknown, calls: string[], keys: string[]) {
  assert.equal(out, reply, "the reply object comes back untouched");
  assert.equal((out as { _meta?: unknown })._meta, undefined, "no card _meta");
  assert.deepEqual(calls, [], "no signed link minted");
  const parsed = JSON.parse((out as { content: Array<{ text: string }> }).content[0].text);
  assert.deepEqual(Object.keys(parsed).sort(), [...keys].sort(), "the documented keys");
}

test("get_session_details: cards off or text-only host gives the plain contract", async () => {
  const session = {
    sessionId: "session_sample_1",
    title: "Sample",
    scheduledDate: "2026-11-20",
    blocks: [{ blockType: "strength", semanticType: "main", exercises: [{ exerciseName: "Goblet squat", sets: [{ type: "strength", targetReps: 8 }] }] }],
  };
  await eachPlainGate(async (host) => {
    const reply = text(session);
    const { calls, mint } = countingMint();
    assertPlain(await withSessionCard(reply, session, null, mint, host), reply, calls, ["sessionId", "title", "scheduledDate", "blocks"]);
  });
});

test("get_active_program: cards off or text-only host gives the plain contract, durationMinutes included", async () => {
  const result = {
    weekNote: "A week is Monday to Sunday.",
    programs: [{ kind: "program", weekStartsOn: "2026-11-16", currentWeekSessions: [{ sessionId: "s1", scheduledDate: "2026-11-18", focus: "Tempo run", slotType: "run", isCompleted: false, durationMinutes: 50 }] }],
    primaryProgramId: "queue_sample",
    asOf: "2026-11-16T00:00:00.000Z",
    today: "2026-11-16",
  };
  await eachPlainGate(async (host) => {
    const reply = text(result);
    const { calls, mint } = countingMint();
    const out = await withWeekCard(reply, result, null, mint, host);
    assertPlain(out, reply, calls, ["weekNote", "programs", "primaryProgramId", "asOf", "today"]);
    assert.equal(JSON.parse(out.content[0].text).programs[0].currentWeekSessions[0].durationMinutes, 50, "durationMinutes stays for the assistant");
  });
});

test("get_weekly_debrief: cards off or text-only host gives the plain contract", async () => {
  const result = shapeDebrief({ weekStarting: "2026-11-16", metrics: { sessionsCompleted: 2, sessionsPlanned: 3 }, nextWeekFocus: "Easy week" }, null);
  await eachPlainGate(async (host) => {
    const reply = text(result);
    const { calls, mint } = countingMint();
    assertPlain(await withDebriefCard(reply, result, null, mint, host), reply, calls, Object.keys(result));
  });
});

test("get_body_analysis: cards off or text-only host gives the plain contract, history included", async () => {
  const analysis = bodyAnalysisFromCore(
    {
      analyzedAt: "2026-11-10T00:00:00.000Z",
      source: "photo",
      measurements: { waistCm: 80, hipsCm: 95, shouldersCm: 110 },
      ratios: {},
      areasOfFocus: [],
      history: [
        { analyzedAt: "2026-11-10T00:00:00.000Z", waistCm: 80, hipsCm: 95, shouldersCm: 110 },
        { analyzedAt: "2026-10-10T00:00:00.000Z", waistCm: 82, hipsCm: 96, shouldersCm: 109 },
      ],
    },
    "https://example.invalid/scan",
  );
  assert.ok(Object.keys(analysis).includes("history"), "history is part of the contract");
  await eachPlainGate(async (host) => {
    const reply = text(analysis);
    const { calls } = countingMint();
    assertPlain(withBodyCard(reply, analysis as Record<string, unknown>, host), reply, calls, Object.keys(analysis));
  });
});

async function listedTools(register: (server: McpServer) => void, clientClass: "claude" | "other") {
  const server = new McpServer({ name: "test-gateway", version: "0.0.0" });
  runWithConnectorFacts({ profileId: "profile_test", clientClass }, () => register(server));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-host", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.listTools()).tools as Array<{ name: string; _meta?: unknown; annotations?: Record<string, unknown> }>;
  } finally {
    await client.close();
    await server.close();
  }
}

const REGISTER_ALL = (server: McpServer) => {
  registerGetSessionDetails(server);
  registerGetActiveProgram(server);
  registerGetWeeklyDebrief(server);
  registerGetBodyAnalysis(server);
  registerModifyTrainingSession(server);
};

test("listing: a text-only host and the off switch list all five tools as plain tools", async () => {
  for (const tool of await listedTools(REGISTER_ALL, "other")) assert.equal(tool._meta, undefined, tool.name);
  const before = process.env.PELARIS_CARDS;
  process.env.PELARIS_CARDS = "off";
  try {
    for (const tool of await listedTools(REGISTER_ALL, "claude")) assert.equal(tool._meta, undefined, tool.name);
  } finally {
    if (before === undefined) delete process.env.PELARIS_CARDS;
    else process.env.PELARIS_CARDS = before;
  }
});

test("modify_training_session is not idempotent (a repeat of reduceVolume or increaseIntensity compounds)", async () => {
  const tools = await listedTools(REGISTER_ALL, "other");
  const modify = tools.find((t) => t.name === "modify_training_session");
  assert.equal(modify?.annotations?.idempotentHint, false);
  assert.equal(modify?.annotations?.destructiveHint, true);
});
