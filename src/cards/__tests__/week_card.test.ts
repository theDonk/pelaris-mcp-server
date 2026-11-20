/**
 * Week card data mapping tests (node:test). Run after build. All data is made up.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const { CARD_DATA_META_KEY, cardCallableToolMeta } = await import("../card_shell.js");
const { WEEK_CARD, WEEK_CARD_OPEN_ROUTE, WEEK_CARD_MOVE_TOOL, WEEK_CARD_SKIP_TOOL, buildWeekCardData, mondayOf, weekDateLabel } = await import("../week_card.js");
const { HANDOFF_ROUTES } = await import("../../tools/shared/entry_links.js");
const { withWeekCard } = await import("../../tools/user/get_active_program.js");

const { hostProfileFrom } = await import("../host.js");
const CLAUDE = hostProfileFrom({ assistantClass: "claude" }, {});

const session = (id: string, date: string, focus: string | null, extra: Record<string, unknown> = {}) => ({
  sessionId: id,
  focus,
  slotType: "run",
  scheduledDate: date,
  isCompleted: false,
  hasCoachNote: true,
  adaptationApplied: false,
  ...extra,
});

const reply = () => ({
  weekNote: "A week is Monday to Sunday.",
  primaryProgramId: "queue_sample",
  today: "2026-11-19",
  programs: [
    { programId: "manual_sample", kind: "manual_log", currentWeekSessions: [session("m1", "2026-11-17", "Logged walk")] },
    {
      programId: "queue_sample",
      kind: "program",
      title: "Sample 12 week plan",
      currentWeek: 3,
      currentPhase: { phase: "Build", focus: "A private focus line" },
      weekStartsOn: "2026-11-16",
      weekEndsOn: "2026-11-22",
      currentWeekSessions: [
        session("s1", "2026-11-16", "Strength", { isCompleted: true, durationMinutes: 45 }),
        session("s2", "2026-11-18", "Easy run"),
        session("s3", "2026-11-19", "Tempo run", { durationMinutes: 50 }),
        session("s4", "2026-11-21", null),
      ],
      nextWeekNumber: 4,
      nextWeekSessions: [session("s5", "2026-11-28", "Long run", { durationMinutes: 75 })],
    },
  ],
});

test("dates: weeks start Monday, labels read 'Mon 23 Nov'", () => {
  assert.equal(mondayOf("2026-11-19"), "2026-11-16");
  assert.equal(mondayOf("2026-11-22"), "2026-11-16", "Sunday belongs to the week before");
  assert.equal(mondayOf("2026-11-16"), "2026-11-16");
  assert.equal(weekDateLabel("2026-11-23"), "Mon 23 Nov");
});

test("full data: the primary program, seven days, both weeks, moves only today or later and not done", () => {
  const data = buildWeekCardData(reply(), "https://example.invalid/open");
  assert.ok(data);
  assert.equal(data.programTitle, "Sample 12 week plan");
  assert.equal(data.weeks.length, 2);
  const [thisWeek, nextWeek] = data.weeks;
  assert.equal(thisWeek.heading, "This week");
  assert.equal(thisWeek.weekLine, "Week 3, Build");
  assert.equal(thisWeek.rangeLabel, "Mon 16 Nov to Sun 22 Nov");
  assert.deepEqual(thisWeek.days.map((d) => d.dayShort), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  assert.deepEqual(thisWeek.days.map((d) => d.canReceive), [false, false, false, true, true, true, true]);
  const byDay = Object.fromEntries(thisWeek.days.map((d) => [d.dayShort, d.sessions]));
  assert.deepEqual(byDay.Mon, [{ sessionId: "s1", label: "Strength", minutes: 45, isCompleted: true, isSkipped: false, canMove: false, canSkip: false }]);
  assert.deepEqual(byDay.Wed, [{ sessionId: "s2", label: "Easy run", minutes: null, isCompleted: false, isSkipped: false, canMove: false, canSkip: false }], "yesterday cannot move or be skipped");
  assert.deepEqual(byDay.Thu, [{ sessionId: "s3", label: "Tempo run", minutes: 50, isCompleted: false, isSkipped: false, canMove: true, canSkip: true }], "today can move or be skipped");
  assert.equal(byDay.Sat[0].label, "run", "no focus: the slot's own text, not a mapped label");
  assert.deepEqual(byDay.Tue, []);
  assert.equal(nextWeek.heading, "Next week");
  assert.equal(nextWeek.weekLine, "Week 4");
  assert.equal(nextWeek.rangeLabel, "Mon 23 Nov to Sun 29 Nov");
  assert.equal(nextWeek.days[5].sessions[0].minutes, 75);
  assert.ok(nextWeek.days.every((d) => d.canReceive));
  assert.ok(!JSON.stringify(data).includes("private focus"));
  assert.ok(!JSON.stringify(data).includes("Logged walk"), "a manual log is not the week");
});

test("sparse data: no week start falls back to today's Monday; no next week means one week; no minutes", () => {
  const data = buildWeekCardData(
    {
      today: "2026-11-25",
      programs: [{ programId: "q", kind: "program", currentWeekSessions: [session("a", "2026-11-26", "Swim"), session("b", "2026-12-09", "Out of week")] }],
    },
    null,
  );
  assert.ok(data);
  assert.equal(data.weeks.length, 1);
  assert.equal(data.weeks[0].rangeLabel, "Mon 23 Nov to Sun 29 Nov");
  assert.equal(data.weeks[0].weekLine, null);
  assert.equal(data.programTitle, null);
  const all = data.weeks[0].days.flatMap((d) => d.sessions);
  assert.deepEqual(all.map((s) => s.sessionId), ["a"], "a session outside the week is left off");
  assert.equal(all[0].minutes, null);
});

test("missing fields: no today means nothing can move; sessions without id or date are left off", () => {
  const data = buildWeekCardData(
    {
      programs: [{
        kind: "program",
        weekStartsOn: "2026-11-16",
        currentWeekSessions: [session("a", "2026-11-20", "Ride"), { focus: "No id", scheduledDate: "2026-11-20" }, session("c", "", "No date")],
      }],
    },
    null,
  );
  assert.ok(data);
  const all = data.weeks[0].days.flatMap((d) => d.sessions);
  assert.deepEqual(all.map((s) => s.sessionId), ["a"]);
  assert.equal(all[0].canMove, false);
  assert.ok(data.weeks[0].days.every((d) => !d.canReceive));
});

test("a skipped session reads skipped, never done, and can neither move nor be skipped again", () => {
  const source = reply();
  // What a server sends for a skipped session; `isCompleted` true is the old reading of the same row.
  source.programs[1].currentWeekSessions![2] = session("s3", "2026-11-19", "Tempo run", { isSkipped: true, isCompleted: true });
  const data = buildWeekCardData(source, null);
  assert.ok(data);
  const thu = data.weeks[0].days[3].sessions[0];
  assert.deepEqual(thu, { sessionId: "s3", label: "Tempo run", minutes: null, isCompleted: false, isSkipped: true, canMove: false, canSkip: false });
});

test("nothing to show means no card", () => {
  assert.equal(buildWeekCardData({ programs: [], message: "No program" }, null), null);
  assert.equal(buildWeekCardData({ today: "2026-11-19", programs: [{ kind: "manual_log", currentWeekSessions: [session("m", "2026-11-19", "Walk")] }] }, null), null);
  assert.equal(buildWeekCardData({ today: "2026-11-19", programs: [{ kind: "program", weekStartsOn: "2026-11-16", currentWeekSessions: [] }] }, null), null);
  assert.equal(buildWeekCardData({ programs: [{ kind: "program", currentWeekSessions: [session("a", "2026-11-20", "Ride")] }] }, null), null, "no week start and no today");
});

test("routes and tools: open is a real handoff route; the move tool is the write tool", () => {
  assert.ok((HANDOFF_ROUTES as readonly string[]).includes(WEEK_CARD_OPEN_ROUTE));
  assert.equal(WEEK_CARD_MOVE_TOOL, "card_reschedule_session");
  const html = WEEK_CARD.html();
  assert.match(html, /card\.callTool\("card_reschedule_session", \{ sessionId: p\.sessionId, newDate: p\.to\.date \}\)/);
  assert.doesNotMatch(html, /modify_training_session|rescheduleSessions/, "the card never calls the model's write tool");
  assert.equal(WEEK_CARD_SKIP_TOOL, "card_skip_session");
  assert.match(html, /card\.callTool\("card_skip_session", \{ sessionId: p\.sessionId \}\)/);
  assert.doesNotMatch(html, /delete_session/, "a skip never deletes");
  assert.equal(html.match(/card\.callTool\(/g)?.length, 2, "two tool calls in the card: move and skip");
  assert.equal(html.match(/confirmMove(?![A-Za-z])/g)?.length, 2, "confirmMove is defined once and bound only to the Confirm tap");
  assert.match(html, /\$\("confirm-yes"\)\.addEventListener\("click", confirmMove\)/);
  assert.match(html, /confirmSkip\(p\)/, "a skip is written only from the Confirm tap");
  assert.ok(html.includes('el("button", "wk-move wk-skip", "Skip")'), "a Skip control on each open session");
  assert.match(html, /id="confirm-yes">Confirm</);
  assert.ok(html.includes('el("button", "wk-move", "Move")'), "a non-drag Move control");
  const CHATGPT = hostProfileFrom({ assistantClass: "chatgpt" }, {});
  assert.deepEqual(cardCallableToolMeta({}, CHATGPT), { ui: { visibility: ["app"] }, "openai/widgetAccessible": true });
  assert.deepEqual(cardCallableToolMeta({}, CLAUDE), { ui: { visibility: ["app"] } });
  assert.equal(cardCallableToolMeta({ PELARIS_CARDS: "off" }, CHATGPT), undefined);
});

test("withWeekCard: text unchanged, card data allow-listed, link minted for the program route", async () => {
  const result = reply();
  const text = { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  const routes: string[] = [];
  const out = await withWeekCard(text, result, null, async (route) => {
    routes.push(route);
    return `https://example.invalid/open/${route}?h=sample`;
  }, CLAUDE);
  assert.deepEqual(routes, ["program"]);
  assert.deepEqual(out.content, text.content);
  const envelope = out._meta?.[CARD_DATA_META_KEY] as { card: string; v: number; data: Record<string, unknown> };
  assert.equal(envelope.card, "week");
  assert.equal(envelope.v, 1);
  const card = envelope.data;
  assert.equal(card.openUrl, "https://example.invalid/open/program?h=sample");
  assert.deepEqual(Object.keys(card).sort(), ["openUrl", "programTitle", "today", "weeks"]);
  assert.ok(!JSON.stringify(card).includes("hasCoachNote"));
});

test("withWeekCard: a failed mint still draws the card; off and empty leave the plain reply", async () => {
  const result = reply();
  const text = { content: [{ type: "text" as const, text: "x" }] };
  const out = await withWeekCard(text, result, null, async () => { throw new Error("store down"); }, CLAUDE);
  assert.equal((out._meta?.[CARD_DATA_META_KEY] as { data: Record<string, unknown> }).data.openUrl, null);
  const before = process.env.PELARIS_CARDS;
  process.env.PELARIS_CARDS = "off";
  try {
    assert.equal(await withWeekCard(text, result, null, async () => "https://example.invalid", CLAUDE), text);
  } finally {
    if (before === undefined) delete process.env.PELARIS_CARDS;
    else process.env.PELARIS_CARDS = before;
  }
  assert.equal(await withWeekCard(text, { programs: [] }, null, async () => "x", CLAUDE), text);
});
