/**
 * Week card page tests: the real bridge and card script run in the vm harness against a
 * stub host (card_dom_harness.ts). All data is made up.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const { WEEK_CARD, WEEK_CARD_PENDING_NOTE, buildWeekCardData } = await import("../week_card.js");
const { envelope, openCardPage } = await import("./card_dom_harness.js");
type HostReply = import("./card_dom_harness.js").HostReply;
type CardPage = import("./card_dom_harness.js").CardPage;

const DATA = buildWeekCardData(
  {
    primaryProgramId: "queue_sample",
    today: "2026-11-26",
    programs: [
      {
        programId: "queue_sample",
        kind: "program",
        title: "Sample plan",
        weekStartsOn: "2026-11-23",
        currentWeekSessions: [{ sessionId: "s1", focus: "Tempo run", scheduledDate: "2026-11-26", isCompleted: false }],
      },
    ],
  },
  "https://example.test/open",
)!;
const toolResult = () => ({ _meta: { "pelaris/card": envelope(WEEK_CARD, structuredClone(DATA)) } });
const MOVED = { content: [{ type: "text", text: JSON.stringify({ moved: [{ sessionId: "s1", newDate: "2026-11-27" }], message: "Done" }) }] };
const FULL_CONTEXT = { availableDisplayModes: ["inline", "fullscreen"], displayMode: "inline" };

function stubHost(onCall: () => HostReply, onMessage: () => HostReply = () => ({ result: {} })) {
  return (method: string, params: Record<string, unknown>): HostReply => {
    if (method === "ui/request-display-mode") return { result: { mode: params.mode } };
    if (method === "tools/call") return onCall();
    if (method === "ui/message") return onMessage();
    return { result: {} };
  };
}

const calls = (page: CardPage, method: string) => page.sent.filter((m) => m.method === method);

/** Opens full screen, picks Move on the Tempo run, picks Fri 27 Nov. Leaves the confirm panel open. */
async function askToMove(page: CardPage): Promise<void> {
  page.$("rearrange").click();
  await page.settle();
  const move = page.body.all().find((e) => e.classList.contains("wk-move"));
  assert.ok(move, "a Move button for the Tempo run");
  move.click();
  const fri = page.$("picker-days").children.find((b) => b.textContent === "Fri 27 Nov");
  assert.ok(fri, "Fri 27 Nov is offered");
  fri.click();
  assert.ok(page.$("confirm").shown, "the confirm panel shows");
}

async function load(opts: Parameters<typeof openCardPage>[1]): Promise<CardPage> {
  const page = await openCardPage(WEEK_CARD.html(), { hostContext: FULL_CONTEXT, ...opts });
  if (opts?.host) page.notify("ui/notifications/tool-result", toolResult());
  await page.settle();
  return page;
}

test("success: one tool call with the exact move, and the tile moves", async () => {
  const page = await load({ host: stubHost(() => ({ result: MOVED })) });
  await askToMove(page);
  page.$("confirm-yes").click();
  page.$("confirm-yes").click(); // a double tap
  await page.settle();
  const tc = calls(page, "tools/call");
  assert.equal(tc.length, 1, "sent once");
  assert.deepEqual(JSON.parse(JSON.stringify(tc[0].params)), { name: "card_reschedule_session", arguments: { sessionId: "s1", newDate: "2026-11-27" } });
  assert.match(page.$("note").textContent, /^Moved: Tempo run, Thu 26 Nov to Fri 27 Nov/);
});

test("error result: shown in the card, never sent again by any path", async () => {
  let openaiCalls = 0;
  const page = await load({
    host: stubHost(() => ({ result: { isError: true, content: [{ type: "text", text: "Error: That day is full" }] } })),
    openai: { callTool: () => { openaiCalls++; return {}; } },
  });
  await askToMove(page);
  page.$("confirm-yes").click();
  await page.settle();
  assert.equal(calls(page, "tools/call").length, 1);
  assert.equal(calls(page, "ui/message").length, 0, "no chat message as a second try");
  assert.equal(openaiCalls, 0, "no fallback transport");
  assert.equal(page.$("note").textContent, "That day is full");
});

test("host error (not method-not-found): no fallback, no chat message", async () => {
  let openaiCalls = 0;
  const page = await load({
    host: stubHost(() => ({ error: { code: -32603, message: "Something went wrong" } })),
    openai: { callTool: () => { openaiCalls++; return {}; } },
  });
  await askToMove(page);
  page.$("confirm-yes").click();
  await page.settle();
  assert.equal(calls(page, "tools/call").length, 1);
  assert.equal(calls(page, "ui/message").length, 0);
  assert.equal(openaiCalls, 0);
});

test("timeout: the still-checking note, no second send, and no way to repeat that move", async () => {
  let openaiCalls = 0;
  const page = await load({ host: stubHost(() => "silent"), openai: { callTool: () => { openaiCalls++; return {}; } } });
  await askToMove(page);
  page.$("confirm-yes").click();
  await page.settle();
  assert.equal(page.$("confirm-yes").disabled, true, "Confirm is disabled until a definite answer");
  page.runTimers();
  await page.settle();
  assert.equal(page.$("note").textContent, WEEK_CARD_PENDING_NOTE);
  assert.equal(calls(page, "tools/call").length, 1);
  assert.equal(calls(page, "ui/message").length, 0);
  assert.equal(openaiCalls, 0);
  assert.ok(!page.body.all().some((e) => e.classList.contains("wk-move")), "no Move button for the session in doubt");
});

test("no host: the ChatGPT runtime is used, once", async () => {
  const toolCalls: unknown[] = [];
  const page = await load({
    openai: {
      toolResponseMetadata: toolResult()._meta,
      requestDisplayMode: async ({ mode }: { mode: string }) => ({ mode }),
      callTool: async (name: string, args: unknown) => {
        toolCalls.push([name, args]);
        return MOVED;
      },
    },
  });
  await askToMove(page);
  page.$("confirm-yes").click();
  await page.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(toolCalls)), [["card_reschedule_session", { sessionId: "s1", newDate: "2026-11-27" }]]);
  assert.match(page.$("note").textContent, /^Moved: Tempo run/);
});

test("method-not-found: the fallback transport is used, once", async () => {
  let openaiCalls = 0;
  const page = await load({
    host: stubHost(() => ({ error: { code: -32601, message: "Method not found" } })),
    openai: { callTool: async () => { openaiCalls++; return MOVED; } },
  });
  await askToMove(page);
  page.$("confirm-yes").click();
  await page.settle();
  assert.equal(calls(page, "tools/call").length, 1);
  assert.equal(openaiCalls, 1);
});

test("a successful move sends no chat message; Tell the coach sends exactly one, on tap", async () => {
  const page = await load({ host: stubHost(() => ({ result: MOVED })) });
  await askToMove(page);
  page.$("confirm-yes").click();
  await page.settle();
  assert.equal(calls(page, "ui/message").length, 0, "no model turn nobody asked for");
  assert.equal(page.$("moved-line").textContent, "Moved: Tempo run, Thu 26 Nov to Fri 27 Nov");
  assert.ok(page.$("tell").shown, "Tell the coach is offered");
  page.$("tell").click();
  page.$("tell").click();
  await page.settle();
  const msgs = calls(page, "ui/message");
  assert.equal(msgs.length, 1);
  assert.equal(
    JSON.stringify(msgs[0].params),
    JSON.stringify({ role: "user", content: [{ type: "text", text: "I moved my Tempo run from Thu 26 Nov to Fri 27 Nov in the week card." }] }),
  );
  assert.equal(page.$("tell").shown, false);
});

const SKIPPED = { content: [{ type: "text", text: JSON.stringify({ skipped: [{ sessionId: "s1" }], message: "Session skipped." }) }] };

/** Opens full screen and taps Skip on the Tempo run. Leaves the confirm panel open. */
async function askToSkip(page: CardPage): Promise<void> {
  page.$("rearrange").click();
  await page.settle();
  const skip = page.body.all().find((e) => e.classList.contains("wk-skip"));
  assert.ok(skip, "a Skip button for the Tempo run");
  assert.equal(skip.textContent, "Skip");
  skip.click();
  assert.ok(page.$("confirm").shown, "the confirm panel shows");
}

test("skip: nothing is sent until Confirm, then one tool call with the session only", async () => {
  const page = await load({ host: stubHost(() => ({ result: SKIPPED })) });
  await askToSkip(page);
  assert.equal(page.$("confirm-title").textContent, "Skip Thursday Tempo run?");
  assert.match(page.$("confirm-detail").textContent, /It stays in your plan, marked as skipped\./);
  assert.equal(page.$("confirm-yes").textContent, "Skip session");
  assert.equal(calls(page, "tools/call").length, 0, "the Skip button alone writes nothing");
  page.$("confirm-yes").click();
  page.$("confirm-yes").click(); // a double tap
  await page.settle();
  const tc = calls(page, "tools/call");
  assert.equal(tc.length, 1, "sent once");
  assert.deepEqual(JSON.parse(JSON.stringify(tc[0].params)), { name: "card_skip_session", arguments: { sessionId: "s1" } });
  assert.equal(page.$("note").textContent, "Skipped: Tempo run, Thu 26 Nov");
  assert.ok(!page.body.all().some((e) => e.classList.contains("wk-move")), "a skipped session has no Move or Skip");
  assert.equal(calls(page, "ui/message").length, 0, "no model turn nobody asked for");
  page.$("tell").click();
  await page.settle();
  const msgs = calls(page, "ui/message");
  assert.equal(msgs.length, 1);
  assert.equal(
    JSON.stringify(msgs[0].params),
    JSON.stringify({ role: "user", content: [{ type: "text", text: "I skipped my Tempo run on Thu 26 Nov in the week card." }] }),
  );
});

test("skip: Cancel changes nothing and sends nothing", async () => {
  const page = await load({ host: stubHost(() => ({ result: SKIPPED })) });
  await askToSkip(page);
  page.$("confirm-no").click();
  await page.settle();
  assert.equal(calls(page, "tools/call").length, 0);
  assert.equal(page.$("note").textContent, "Nothing changed.");
  assert.ok(page.body.all().some((e) => e.classList.contains("wk-skip")), "Skip is still offered");
});

test("skip, then a move: the confirm button reads Confirm again", async () => {
  const page = await load({ host: stubHost(() => ({ result: MOVED })) });
  await askToSkip(page);
  page.$("confirm-no").click();
  const move = page.body.all().find((e) => e.classList.contains("wk-move") && !e.classList.contains("wk-skip"));
  assert.ok(move);
  move.click();
  const fri = page.$("picker-days").children.find((b) => b.textContent === "Fri 27 Nov");
  assert.ok(fri);
  fri.click();
  assert.equal(page.$("confirm-yes").textContent, "Confirm");
  page.$("confirm-yes").click();
  await page.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(calls(page, "tools/call")[0].params)), { name: "card_reschedule_session", arguments: { sessionId: "s1", newDate: "2026-11-27" } });
});

test("skip error: shown in the card, never sent again by any path", async () => {
  let openaiCalls = 0;
  const page = await load({
    host: stubHost(() => ({ result: { isError: true, content: [{ type: "text", text: "Error: Session s1 is already skipped" }] } })),
    openai: { callTool: () => { openaiCalls++; return {}; } },
  });
  await askToSkip(page);
  page.$("confirm-yes").click();
  await page.settle();
  assert.equal(calls(page, "tools/call").length, 1);
  assert.equal(calls(page, "ui/message").length, 0, "no chat message as a second try");
  assert.equal(openaiCalls, 0, "no fallback transport");
  assert.equal(page.$("note").textContent, "Session s1 is already skipped");
});

test("skip timeout: the still-checking note, no second send, and no way to repeat it", async () => {
  const page = await load({ host: stubHost(() => "silent") });
  await askToSkip(page);
  page.$("confirm-yes").click();
  await page.settle();
  page.runTimers();
  await page.settle();
  assert.equal(page.$("note").textContent, WEEK_CARD_PENDING_NOTE);
  assert.equal(calls(page, "tools/call").length, 1);
  assert.equal(calls(page, "ui/message").length, 0);
  assert.ok(!page.body.all().some((e) => e.classList.contains("wk-move")), "no Move or Skip for the session in doubt");
});
