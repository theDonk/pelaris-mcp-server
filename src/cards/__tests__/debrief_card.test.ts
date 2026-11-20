/**
 * Debrief card data mapping tests (node:test). Run after build. All data is made up.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const { CARD_DATA_META_KEY } = await import("../card_shell.js");
const { DEBRIEF_CARD, DEBRIEF_CARD_OPEN_ROUTE, DEBRIEF_CARD_TAGLINE, buildDebriefCardData, recordLineFrom } = await import("../debrief_card.js");
const { HANDOFF_ROUTES } = await import("../../tools/shared/entry_links.js");
const { withDebriefCard, shapeDebrief } = await import("../../tools/user/get_weekly_debrief.js");

const pr = (name: string, value: number, previousValue: number | null) => ({ exerciseName: name, value, previousValue, date: "2026-11-18" });

const fullDebrief = () =>
  shapeDebrief(
    {
      weekStarting: "2026-11-16",
      summary: "A private summary line the card never shows.",
      metrics: {
        sessionsCompleted: 9,
        sessionsPlanned: 12,
        weekCounts: { basis: "program", programCompleted: 4, programPlanned: 4, bonusCompleted: 1, totalCompleted: 5, line: "Program 4 of 4 plus 1 bonus" },
        plateauExercises: ["Overhead press"],
        improvingExercises: ["Back squat", "Row"],
        newPrs: [pr("Back squat", 80, 77.5)],
      },
      nextWeekFocus: "Build the long run and keep legs fresh",
    },
    null,
  );

test("tagline is exact", () => {
  assert.equal(DEBRIEF_CARD_TAGLINE, "Pelaris · Stop tracking. Start navigating.");
});

test("full data: week, program pair, bonus, one record as data, focus; no watch line, no summary", () => {
  const data = buildDebriefCardData(fullDebrief(), "https://example.invalid/open");
  assert.deepEqual(data, {
    weekLabel: "Week of Mon 16 Nov",
    sessionsLine: "4 of 4 sessions",
    completed: 4,
    planned: 4,
    bonusLine: "plus 1 bonus session",
    recordLine: "New record: Back squat 80, was 77.5",
    focus: "Build the long run and keep legs fresh",
    tagline: DEBRIEF_CARD_TAGLINE,
    fileName: "pelaris-week-16-nov.png",
    shareText: "Week of Mon 16 Nov\n4 of 4 sessions, plus 1 bonus session\nNew record: Back squat 80, was 77.5\nNext week: Build the long run and keep legs fresh\nPelaris · Stop tracking. Start navigating.",
    openUrl: "https://example.invalid/open",
  });
  assert.ok(!JSON.stringify(data).includes("Overhead press"), "plateau is a judgement for the assistant, not a card rule");
  assert.ok(!JSON.stringify(data).includes("private summary"));
});

test("the record line: only exactly one new record, stated as data, never a pick", () => {
  assert.equal(recordLineFrom([pr("Back squat", 80, 77.5)]), "New record: Back squat 80, was 77.5");
  assert.equal(recordLineFrom([pr("5 km run", 1520, null)]), "New record: 5 km run 1520");
  assert.equal(recordLineFrom([pr("Back squat", 80, 77.5), pr("Row", 60, 57.5)]), null, "two records: choosing one is a judgement");
  assert.equal(recordLineFrom([]), null);
  assert.equal(recordLineFrom(undefined), null);
  assert.equal(recordLineFrom([{ exerciseName: "", value: 1 }]), null);
});

test("sparse data: no counts basis, no bonus, no records, no focus", () => {
  const data = buildDebriefCardData(
    shapeDebrief({ weekStarting: "2026-11-09", metrics: { sessionsCompleted: 2, sessionsPlanned: 3 } }, null),
    null,
  );
  assert.ok(data);
  assert.equal(data.sessionsLine, "2 of 3 sessions");
  assert.equal(data.bonusLine, null);
  assert.equal(data.recordLine, null);
  assert.equal(data.focus, null);
  assert.equal(data.shareText, "Week of Mon 9 Nov\n2 of 3 sessions\nPelaris · Stop tracking. Start navigating.");
});

test("missing fields: no week label, bonus only, odd values", () => {
  const data = buildDebriefCardData({ metrics: { sessionsCompleted: 0, sessionsPlanned: 0, bonusSessions: 2, newPrs: "nope" } }, null);
  assert.ok(data);
  assert.equal(data.weekLabel, "Your week");
  assert.equal(data.sessionsLine, "0 sessions");
  assert.equal(data.bonusLine, "plus 2 bonus sessions");
  assert.equal(data.fileName, "pelaris-week.png");
});

test("nothing to show means no card: the empty week message, or all zeros", () => {
  assert.equal(
    buildDebriefCardData({ weekStarting: "2026-11-16", message: "No weekly debriefs available yet." }, null),
    null,
  );
  assert.equal(buildDebriefCardData({ metrics: { sessionsCompleted: 0, sessionsPlanned: 0 } }, null), null);
});

test("the page: no ring, the tagline drawn from data, canvas made in script, Copy text fallback", () => {
  assert.ok((HANDOFF_ROUTES as readonly string[]).includes(DEBRIEF_CARD_OPEN_ROUTE));
  const html = DEBRIEF_CARD.html();
  assert.match(html, /class="db-bar"/);
  assert.match(html, /createElement\("canvas"\)/);
  assert.match(html, /"Copy text"/);
  assert.doesNotMatch(html, /Headline win|One thing to watch/);
});

test("withDebriefCard: text unchanged, data allow-listed, link minted; empty week and off leave the plain reply", async () => {
  const result = fullDebrief();
  const text = { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  const routes: string[] = [];
  const out = await withDebriefCard(text, result, null, async (route) => {
    routes.push(route);
    return `https://example.invalid/open/${route}?h=sample`;
  });
  assert.deepEqual(routes, ["program"]);
  assert.deepEqual(out.content, text.content);
  const card = out._meta?.[CARD_DATA_META_KEY] as Record<string, unknown>;
  assert.equal(card.card, "debrief");
  assert.equal(card.openUrl, "https://example.invalid/open/program?h=sample");

  const empty = { weekStarting: "2026-11-16", message: "No weekly debriefs available yet." };
  const emptyText = { content: [{ type: "text" as const, text: JSON.stringify(empty) }] };
  assert.equal(await withDebriefCard(emptyText, empty, null, async () => "x"), emptyText);

  const before = process.env.PELARIS_CARDS;
  process.env.PELARIS_CARDS = "off";
  try {
    assert.equal(await withDebriefCard(text, result, null, async () => "x"), text);
  } finally {
    if (before === undefined) delete process.env.PELARIS_CARDS;
    else process.env.PELARIS_CARDS = before;
  }
});
