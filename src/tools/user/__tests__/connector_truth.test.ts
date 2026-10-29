/**
 * Connector truth (1.4.1 D2). node:test, no network, no Firestore: the program tools take their reads as
 * injected dependencies and run behind a real McpServer and client over the SDK's in-memory transport.
 *
 * The 24 Oct ChatGPT QA session: "week 12" beside "week 1", "5 of 21" beside a debrief that said 13, `pending_deferred`
 * read as a fault, two programs with no word on which is main, Manual Workouts read as a plan, a March body scan beside an
 * October weight, and existing benchmarks listed as PRs. The connector now reads the app's own answer (the backend
 * `get_training_truth`, over the coreToolsBridge) and only words it. These tests pin the wording and the shape, and that
 * no tool name or input schema moved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStateNote,
  generationStatusPlain,
  plainDay,
  programTruthFields,
  roleNote,
  weekLine,
  type TrainingTruth,
  type TruthProgram,
} from "../../shared/training_truth.js";
import { registerGetActiveProgram, shapeActiveProgram } from "../get_active_program.js";
import { registerGetWeeklyDebrief, shapeDebrief } from "../get_weekly_debrief.js";
import { consistencyInsight } from "../get_coach_insight.js";
import { bodyAnalysisAsOf } from "../get_body_analysis.js";
import { TEST_CLAIMS, captureLogs, openToolSession } from "./mcp_harness.js";

const READ_CLAIMS = { ...TEST_CLAIMS, scope: "training:read coach:read health:read" };

function hybrid(overrides: Partial<TruthProgram> = {}): TruthProgram {
  return {
    queueId: "queue_hybrid",
    title: "Hybrid 24 Week",
    kind: "program",
    role: "primary",
    isPrimary: true,
    planState: "active",
    generationStatus: "pending_deferred",
    startsOn: "2026-08-24",
    endsOn: "2027-02-07",
    declaredWeeks: 24,
    builtThroughWeek: 10,
    currentWeek: 9,
    weekSource: "calendar",
    notStarted: false,
    weekStartsOn: "2026-10-19",
    weekEndsOn: "2026-10-25",
    phase: { phase: "Base 2", weeks: "7-12", focus: "Build volume" },
    phases: [
      { phase: "Base 1", weeks: "1-6", focus: "Aerobic base", isCurrent: false },
      { phase: "Base 2", weeks: "7-12", focus: "Build volume", isCurrent: true },
    ],
    buildState: "builds_as_you_train",
    nextUnbuiltWeek: 11,
    nextUnbuiltWeekStartsOn: "2026-11-02",
    programEnded: null,
    schedule: [{ week: 9, startsOn: "2026-10-19", built: true, plannedSessions: 4, completedSessions: 1 }],
    currentWeekSessions: [
      { sessionId: "s1", focus: "Tempo Run", slotType: "run", scheduledDate: "2026-10-19", isCompleted: true },
      { sessionId: "s2", focus: "Swim", slotType: "swim", scheduledDate: "2026-10-23", isCompleted: false },
    ],
    completion: { sessionsCompleted: 12, sessionsTotal: 40, completionPercent: 30 },
    ...overrides,
  };
}

const manualLog: TruthProgram = {
  ...hybrid(),
  queueId: "manual_workouts",
  title: "Manual Workouts",
  kind: "manual_log",
  role: "log",
  isPrimary: false,
  generationStatus: "complete",
  startsOn: null,
  endsOn: null,
  declaredWeeks: null,
  builtThroughWeek: 0,
  currentWeek: null,
  weekStartsOn: null,
  weekEndsOn: null,
  phase: null,
  phases: [],
  buildState: null,
  nextUnbuiltWeek: null,
  nextUnbuiltWeekStartsOn: null,
  schedule: [],
  currentWeekSessions: [],
  completion: { sessionsCompleted: 40, sessionsTotal: 40, completionPercent: 100 },
};

function truthOf(overrides: Partial<TrainingTruth> = {}): TrainingTruth {
  return {
    asOf: "2026-10-24T09:00:00.000Z",
    timezone: "Australia/Sydney",
    today: "2026-10-24",
    week: { weekId: "2026-10-19", weekEndId: "2026-10-25", isCurrent: true },
    weekCounts: { basis: "program", programCompleted: 5, programPlanned: 13, bonusCompleted: 4, totalCompleted: 9, line: "Program 5 of 13 · +4 bonus" },
    primaryQueueId: "queue_hybrid",
    programs: [manualLog, hybrid()],
    ...overrides,
  };
}

// ── Wording ──────────────────────────────────────────────────────────────────

test("pending_deferred reads as the next weeks building as you train, not a fault", () => {
  assert.equal(generationStatusPlain("pending_deferred"), "The next weeks build as you train.");
  const note = buildStateNote(hybrid()) ?? "";
  assert.match(note, /The next weeks build as you train/);
  assert.match(note, /Weeks 1 to 10 of 24 are planned/);
  assert.match(note, /week 11 starts Mon 2 Nov/);
  assert.match(note, /not a fault/);
  assert.equal(generationStatusPlain("something_new"), null);
});

test("a failed build is not described as the by-design rolling build", () => {
  const note = buildStateNote(hybrid({ buildState: "build_failed", generationStatus: "deferred_failed" })) ?? "";
  assert.match(note, /did not finish/);
  assert.doesNotMatch(note, /as you train/);
  assert.match(buildStateNote(hybrid({ buildState: "ended", programEnded: { endedOn: "2027-02-07" } })) ?? "", /finished on Sun 7 Feb/);
  assert.match(buildStateNote(hybrid({ buildState: "fully_built" })) ?? "", /All 24 weeks are planned/);
});

test("the primary program is marked, and Manual Workouts is a log, not a plan", () => {
  assert.match(roleNote(hybrid()), /main program/);
  assert.match(roleNote(hybrid({ isPrimary: false, role: "additional" })), /also running/);
  assert.match(roleNote(manualLog), /log of the sessions you added yourself/);
  assert.match(roleNote(manualLog), /not a plan/);
  const fields = programTruthFields(manualLog);
  assert.equal(fields.kind, "manual_log");
  assert.equal("weekLine" in fields, false, "a log has no weeks or phases");
});

test("week lines say the real week, or why there is none", () => {
  assert.equal(weekLine(hybrid()), "Week 9 of 24, Base 2");
  assert.equal(weekLine(hybrid({ currentWeek: null, notStarted: true, startsOn: "2026-11-02" })), "Starts Mon 2 Nov.");
  assert.equal(weekLine(hybrid({ currentWeek: null, programEnded: { endedOn: "2027-02-07" } })), "Finished.");
  assert.equal(plainDay("2026-10-24"), "Sat 24 Oct");
  assert.equal(plainDay("nope"), null);
});

test("body analysis carries an as-of date and its source", () => {
  const out = bodyAnalysisAsOf("2026-03-07T02:00:00.000Z", "photo_scan");
  assert.equal(out.asOf, "2026-03-07");
  assert.match(out.asOfNote, /Measured on Sat 7 Mar/);
  assert.match(out.asOfNote, /source: photo_scan/);
  assert.match(out.asOfNote, /may be newer/);
  assert.match(bodyAnalysisAsOf(null, null).asOfNote, /not recorded/);
});

// ── get_coach_insight: the app's count ───────────────────────────────────────

test("the coach insight says the app's count, with bonus beside it, never as a shortfall", () => {
  const behind = consistencyInsight(truthOf().weekCounts);
  assert.equal(behind?.text, "5 of 13 program sessions done this week (plus 4 bonus beyond the program).");
  const done = consistencyInsight({ basis: "program", programCompleted: 4, programPlanned: 4, bonusCompleted: 0, totalCompleted: 4, line: "Program 4 of 4" });
  assert.match(done?.text ?? "", /All 4 program sessions done this week/);
  const noPlan = consistencyInsight({ basis: "program", programCompleted: 0, programPlanned: 0, bonusCompleted: 3, totalCompleted: 3, line: "x" });
  assert.match(noPlan?.text ?? "", /3 sessions done this week, none from a program plan/);
  assert.equal(consistencyInsight(null), null);
  assert.equal(consistencyInsight({ basis: "program", programCompleted: 0, programPlanned: 0, bonusCompleted: 0, totalCompleted: 0, line: "x" }), null);
});

// ── get_active_program ───────────────────────────────────────────────────────

const OLD_PROGRAM_FIELDS = [
  "programId", "title", "type", "totalSessions", "completedSessions", "completionPercent", "totalWeeks",
  "currentWeek", "currentPhase", "currentWeekSessions", "weeklyOverviews", "generationStatus",
];
const OLD_SESSION_FIELDS = ["sessionId", "focus", "slotType", "isCompleted", "scheduledDate", "hasCoachNote", "adaptationApplied"];

test("shapeActiveProgram keeps every old field name, fills them from the truth, and adds the plain ones", () => {
  const out = shapeActiveProgram(hybrid(), {
    type: "ai_generated",
    weekly_overviews: { "9": "Build" },
    sessions: [{ id: "s1", coach_note: { message: "x" }, adaptation_applied: true }],
  });
  for (const key of OLD_PROGRAM_FIELDS) assert.ok(key in out, `missing ${key}`);
  assert.equal(out.currentWeek, 9, "the calendar week, not the highest built week (10) or the first unfinished (1)");
  assert.equal(out.totalWeeks, 24, "the declared length, not the count of built weeks");
  assert.deepEqual(out.currentPhase, { phase: "Base 2", focus: "Build volume" });
  assert.equal(out.generationStatus, "pending_deferred", "the raw value stays; the plain one is added beside it");
  assert.equal(out.generationStatusPlain, "The next weeks build as you train.");
  assert.equal(out.completedSessions, 12);
  assert.equal(out.isPrimary, true);
  const sessions = out.currentWeekSessions as Array<Record<string, unknown>>;
  for (const key of OLD_SESSION_FIELDS) assert.ok(key in sessions[0], `missing session ${key}`);
  assert.equal(sessions[0].hasCoachNote, true);
  assert.equal(sessions[0].adaptationApplied, true);
  assert.equal(sessions[1].hasCoachNote, false);
});

async function activeReply(truth: TrainingTruth | null, docs: Array<{ id: string; data: () => Record<string, unknown> }>) {
  const session = await openToolSession((server) =>
    registerGetActiveProgram(server, { truth: async () => truth, queueDocs: async () => ({ queueDocs: docs }) }));
  try {
    const listed = await session.listedTool("get_active_program");
    const reply = (await captureLogs(() => session.call("get_active_program", {}, READ_CLAIMS))).value;
    return { reply, listed };
  } finally {
    await session.close();
  }
}

test("get_active_program through the wire: tool name and input schema unchanged, primary named, manual is a log", async () => {
  const docs = [
    { id: "manual_workouts", data: () => ({ title: "Manual Workouts" }) },
    { id: "queue_hybrid", data: () => ({ title: "Hybrid 24 Week", type: "ai_generated", sessions: [] }) },
  ];
  const { reply, listed } = await activeReply(truthOf(), docs);
  assert.ok(listed, "the tool is still registered under its name");
  assert.deepEqual((listed.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}, {}, "no inputs, as before");
  assert.equal(reply.isError, false);
  const body = JSON.parse(reply.text) as { programs: Array<Record<string, unknown>>; primaryProgramId: string };
  assert.equal(body.primaryProgramId, "queue_hybrid");
  const byId = Object.fromEntries(body.programs.map((p) => [p.programId as string, p]));
  assert.equal(byId.queue_hybrid.currentWeek, 9);
  assert.equal(byId.manual_workouts.kind, "manual_log");
  assert.match(byId.manual_workouts.roleNote as string, /not a plan/);
});

test("get_active_program with the app's backend unreachable says so; it never guesses a week", async () => {
  const { reply } = await activeReply(null, [{ id: "queue_hybrid", data: () => ({ sessions: [{ week_number: 12 }] }) }]);
  assert.equal(reply.isError, true);
  assert.match(reply.text, /could not read your program right now/);
  assert.doesNotMatch(reply.text, /12/);
});

test("get_active_program with nothing running keeps its old answer", async () => {
  const { reply } = await activeReply(truthOf({ programs: [] }), []);
  assert.match(reply.text, /No running program found/);
});

// ── get_weekly_debrief ───────────────────────────────────────────────────────

const STORED_DEBRIEF = {
  weekStarting: "2026-10-12",
  summary: "A solid week.",
  metrics: {
    sessionsCompleted: 9,
    sessionsPlanned: 21,
    avgRpe: 6.5,
    benchmarkPRs: ["bench_press_1rm: 90"],
    improvingExercises: [],
    plateauExercises: [],
    weekCounts: { basis: "program" as const, programCompleted: 5, programPlanned: 13, bonusCompleted: 4, totalCompleted: 9, line: "Program 5 of 13 · +4 bonus" },
    currentBenchmarks: ["bench_press_1rm: 90"],
    newPrs: [],
  },
  nextWeekFocus: "Easy week.",
  generatedAt: "2026-10-16T07:00:00.000Z",
};

test("shapeDebrief: the metrics say 5 of 13 like the narrative, bonus is its own field, benchmarks are current benchmarks", () => {
  const out = shapeDebrief(STORED_DEBRIEF, null) as { metrics: Record<string, unknown> };
  assert.equal(out.metrics.sessionsCompleted, 5);
  assert.equal(out.metrics.sessionsPlanned, 13, "never the all-origins 21");
  assert.equal(out.metrics.completionRate, 38);
  assert.equal(out.metrics.bonusSessions, 4);
  assert.equal(out.metrics.totalSessionsCompleted, 9);
  assert.equal(out.metrics.weekCounts, "Program 5 of 13 · +4 bonus");
  assert.deepEqual(out.metrics.currentBenchmarks, ["bench_press_1rm: 90"]);
  assert.match(out.metrics.currentBenchmarksNote as string, /not new personal records/);
  assert.deepEqual(out.metrics.benchmarkPRs, ["bench_press_1rm: 90"], "old field name kept");
  assert.deepEqual(out.metrics.newPrs, []);
  for (const key of ["weekStarting", "summary", "nextWeekFocus", "generatedAt"]) assert.ok(key in out, `missing ${key}`);
});

test("shapeDebrief: a debrief from before program counts falls back to its stored figures, labelled", () => {
  const legacy = { ...STORED_DEBRIEF, metrics: { sessionsCompleted: 5, sessionsPlanned: 21 } };
  const out = shapeDebrief(legacy, null) as { metrics: Record<string, unknown> };
  assert.equal(out.metrics.sessionsPlanned, 21);
  assert.equal(out.metrics.countsBasis, undefined, "no counts object, so nothing claims a basis");
  const labelled = shapeDebrief({
    ...legacy,
    metrics: { ...legacy.metrics, weekCounts: { basis: "all_sessions_legacy", programCompleted: 0, programPlanned: 0, allSessionsPlanned: 21, bonusCompleted: 0, totalCompleted: 5, line: "5 of 21 sessions" } },
  }, null) as { metrics: Record<string, unknown> };
  assert.equal(labelled.metrics.sessionsPlanned, 21);
  assert.equal(labelled.metrics.countsBasis, "all_sessions_legacy");
  assert.match(labelled.metrics.countsNote as string, /every session/);
});

test("shapeDebrief: a fallback debrief says which week was asked for", () => {
  const out = shapeDebrief({ ...STORED_DEBRIEF, fallback: true }, "2026-10-26") as { note: string };
  assert.match(out.note, /No debrief found for the week of Mon 26 Oct/);
});

test("get_weekly_debrief through the wire: asks the backend for the debrief, same input schema, unreachable backend is said plainly", async () => {
  let asked: unknown = null;
  const session = await openToolSession((server) =>
    registerGetWeeklyDebrief(server, { truth: async (_id, input) => { asked = input; return truthOf({ debrief: STORED_DEBRIEF }); } }));
  try {
    const listed = await session.listedTool("get_weekly_debrief");
    assert.deepEqual(Object.keys((listed?.inputSchema as { properties: Record<string, unknown> }).properties), ["weekDate"]);
    const reply = (await captureLogs(() => session.call("get_weekly_debrief", { weekDate: "2026-10-14" }, READ_CLAIMS))).value;
    assert.equal(reply.isError, false);
    assert.deepEqual(asked, { includeDebrief: true, weekDate: "2026-10-14" });
    assert.equal((JSON.parse(reply.text) as { metrics: { sessionsPlanned: number } }).metrics.sessionsPlanned, 13);
  } finally {
    await session.close();
  }

  const down = await openToolSession((server) => registerGetWeeklyDebrief(server, { truth: async () => null }));
  try {
    const reply = (await captureLogs(() => down.call("get_weekly_debrief", {}, READ_CLAIMS))).value;
    assert.equal(reply.isError, true);
    assert.match(reply.text, /could not read your program right now/);
  } finally {
    await down.close();
  }

  const none = await openToolSession((server) => registerGetWeeklyDebrief(server, { truth: async () => truthOf() }));
  try {
    const reply = (await captureLogs(() => none.call("get_weekly_debrief", {}, READ_CLAIMS))).value;
    assert.match(reply.text, /No weekly debriefs available yet/);
  } finally {
    await none.close();
  }
});

test("build notes read naturally for one week and for nothing built yet", () => {
  assert.match(buildStateNote(hybrid({ buildState: "fully_built", declaredWeeks: 1, builtThroughWeek: 1 })) ?? "", /All 1 week is planned/);
  const one = buildStateNote(hybrid({ buildState: "builds_as_you_train", builtThroughWeek: 1 })) ?? "";
  assert.match(one, /^Week 1 of \d+ is planned/);
  const none = buildStateNote(hybrid({ buildState: "builds_as_you_train", builtThroughWeek: 0 })) ?? "";
  assert.match(none, /^No weeks are planned yet/);
  assert.doesNotMatch(none, /Weeks 1 to 0/);
});

test("a debrief fallback names the requested week as a plain day", () => {
  const shaped = shapeDebrief({ fallback: true, weekStarting: "2026-10-19" } as never, "2026-10-12");
  assert.match(String(shaped.note), /week of Mon 12 Oct/);
  const noDate = shapeDebrief({ fallback: true, weekStarting: "2026-10-19" } as never, null);
  assert.equal(noDate.note, "Showing the most recent debrief.");
});
