/**
 * Session card data mapping tests (node:test). Run after build. All data is made up.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const { CARD_DATA_META_KEY } = await import("../card_shell.js");
const {
  SESSION_CARD_START_ROUTE,
  buildSessionCardData,
  describeSets,
  formatSessionDate,
} = await import("../session_card.js");
const { HANDOFF_ROUTES } = await import("../../tools/shared/entry_links.js");
const { withSessionCard } = await import("../../tools/user/get_session_details.js");

const { hostProfileFrom } = await import("../host.js");
const CLAUDE = hostProfileFrom({ assistantClass: "claude" }, {});

const strengthSet = (reps: number, kg: number | null, rpe: number | null = null) => ({
  type: "strength",
  targetWeightKg: kg,
  targetReps: reps,
  targetRpe: rpe,
  actualWeightKg: null,
  actualReps: null,
  actualRpe: null,
  isCompleted: false,
});

const strengthSession = {
  sessionId: "session_sample_1",
  title: "Lower body strength",
  scheduledDate: "2026-11-20",
  durationMinutes: 45,
  coachNote: "A private note the card never shows",
  blocks: [
    {
      blockType: "strength",
      semanticType: "warm_up",
      exercises: [
        { exerciseName: "Leg swings", exerciseId: "ex_a", sets: [strengthSet(10, null)] },
        { exerciseName: "Glute bridge", exerciseId: "ex_b", sets: [strengthSet(12, null)] },
      ],
    },
    {
      blockType: "strength",
      semanticType: "main",
      exercises: [
        { exerciseName: "Goblet squat", exerciseId: "ex_c", sets: [strengthSet(8, 20), strengthSet(8, 20), strengthSet(8, 20)] },
        { exerciseName: "Romanian deadlift", exerciseId: "ex_d", sets: [strengthSet(8, null, 7), strengthSet(8, null, 7)] },
      ],
    },
    {
      blockType: "strength",
      semanticType: "cool_down",
      exercises: [{ exerciseName: "Hip stretch", exerciseId: "ex_e", sets: [] }],
    },
  ],
};

test("dates: yyyy-MM-dd becomes 'Fri 20 Nov'; anything else is hidden", () => {
  assert.equal(formatSessionDate("2026-11-20"), "Fri 20 Nov");
  assert.equal(formatSessionDate("2026-02-30"), null);
  assert.equal(formatSessionDate({ _seconds: 1 }), null);
  assert.equal(formatSessionDate(undefined), null);
});

test("strength: title, date, length, warm-up, main rows with load or RPE; cool-down left out", () => {
  const data = buildSessionCardData(strengthSession, "https://example.invalid/start");
  assert.deepEqual(data, {
    title: "Lower body strength",
    dateLabel: "Fri 20 Nov",
    durationLabel: "45 min",
    warmUp: "Leg swings, Glute bridge",
    rows: [
      { name: "Goblet squat", detail: "3 x 8 · 20 kg" },
      { name: "Romanian deadlift", detail: "2 x 8 · RPE 7" },
    ],
    startUrl: "https://example.invalid/start",
    swapPrompt: "I'd like to swap an exercise in my Lower body strength session.",
  });
});

test("cardio: sets show distance or time", () => {
  const cardio = (distance: number | null, duration: number | null) => ({
    type: "cardio",
    targetDistanceMeters: distance,
    targetDurationSec: duration,
    actualDistanceMeters: null,
    actualDurationSec: null,
    isCompleted: false,
  });
  assert.equal(describeSets(Array(6).fill(cardio(800, null))), "6 x 800 m");
  assert.equal(describeSets([cardio(5000, null)]), "5 km");
  assert.equal(describeSets([cardio(null, 1200)]), "20 min");
  assert.equal(describeSets([cardio(null, 45)]), "45s");
  const data = buildSessionCardData(
    {
      title: "Easy run",
      scheduledDate: "2026-11-23",
      blocks: [{ blockType: "cardio", semanticType: "main", exercises: [{ exerciseName: "Easy run", sets: [cardio(null, 2400)] }] }],
    },
    null,
  );
  assert.deepEqual(data?.rows, [{ name: "Easy run", detail: "40 min" }]);
  assert.equal(data?.dateLabel, "Mon 23 Nov");
});

test("no warm-up: the line is hidden unless a block is typed warm_up", () => {
  const data = buildSessionCardData(
    {
      title: "Upper body",
      blocks: [
        // First block, but not typed as a warm-up: it is a main-set row, not a warm-up line.
        { blockType: "strength", semanticType: null, exercises: [{ exerciseName: "Push-up", sets: [strengthSet(10, null)] }] },
        { blockType: "strength", semanticType: "accessory", exercises: [{ exerciseName: "Plank", sets: [{ type: "strength", targetReps: null, targetDurationSec: 30 }, { type: "strength", targetReps: null, targetDurationSec: 30 }] }] },
      ],
    },
    null,
  );
  assert.equal(data?.warmUp, null);
  assert.deepEqual(data?.rows, [
    { name: "Push-up", detail: "1 x 10" },
    { name: "Plank", detail: "2 x 30s hold" },
  ]);
});

test("missing fields: no title, no date, no length, mixed sets, nameless exercises", () => {
  const data = buildSessionCardData(
    {
      blocks: [
        {
          exercises: [
            { exerciseName: "  ", sets: [strengthSet(5, 50)] },
            { exerciseName: "Back squat", sets: [strengthSet(5, 60), strengthSet(3, 70)] },
            { exerciseName: "Mobility flow" },
          ],
        },
      ],
    },
    null,
  );
  assert.deepEqual(data, {
    title: "Your session",
    dateLabel: null,
    durationLabel: null,
    warmUp: null,
    rows: [
      { name: "Back squat", detail: "2 sets" },
      { name: "Mobility flow", detail: "" },
    ],
    startUrl: null,
    swapPrompt: "I'd like to swap an exercise in my Your session session.",
  });
  assert.equal(buildSessionCardData({ title: "Rest day", blocks: [] }, null), null);
  assert.equal(buildSessionCardData({ title: "Odd", blocks: "nope" }, null), null);
});

test("the start route is one constant and a real handoff route", () => {
  assert.ok((HANDOFF_ROUTES as readonly string[]).includes(SESSION_CARD_START_ROUTE));
});

test("withSessionCard: text unchanged, card data allow-listed, link minted for the start route", async () => {
  const reply = { content: [{ type: "text" as const, text: JSON.stringify(strengthSession) }] };
  const routes: string[] = [];
  const out = await withSessionCard(reply, strengthSession, null, async (route) => {
    routes.push(route);
    return `https://example.invalid/start/${route}?h=sample`;
  }, CLAUDE);
  assert.deepEqual(routes, ["train"]);
  assert.deepEqual(out.content, reply.content);
  const card = out._meta?.[CARD_DATA_META_KEY] as Record<string, unknown>;
  assert.equal(card.card, "session");
  assert.equal(card.startUrl, "https://example.invalid/start/train?h=sample");
  assert.deepEqual(Object.keys(card).sort(), [
    "card", "dateLabel", "durationLabel", "rows", "startUrl", "swapPrompt", "title", "warmUp",
  ]);
  assert.ok(!JSON.stringify(card).includes("private note"));
  assert.ok(!JSON.stringify(card).includes("session_sample_1"));
});

test("withSessionCard: a failed mint still draws the card, without a link", async () => {
  const reply = { content: [{ type: "text" as const, text: "x" }] };
  const out = await withSessionCard(reply, strengthSession, null, async () => {
    throw new Error("store down");
  }, CLAUDE);
  assert.equal((out._meta?.[CARD_DATA_META_KEY] as Record<string, unknown>).startUrl, null);
});

test("withSessionCard: off switch and an empty session leave the plain reply", async () => {
  const reply = { content: [{ type: "text" as const, text: "x" }] };
  const before = process.env.PELARIS_CARDS;
  process.env.PELARIS_CARDS = "off";
  try {
    assert.equal(await withSessionCard(reply, strengthSession, null, async () => "https://example.invalid", CLAUDE), reply);
  } finally {
    if (before === undefined) delete process.env.PELARIS_CARDS;
    else process.env.PELARIS_CARDS = before;
  }
  assert.equal(await withSessionCard(reply, { title: "Empty", blocks: [] }, null, async () => "x", CLAUDE), reply);
});
