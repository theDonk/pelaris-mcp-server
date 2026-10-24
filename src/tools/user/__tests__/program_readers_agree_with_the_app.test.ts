/**
 * The connector's readers agree with the app about what a program is (connector rev 2.1, M1 and M2). node:test, no
 * Firestore: each reader takes its reads as injected dependencies and runs behind a real McpServer and client over
 * the SDK's in-memory transport.
 *
 * Before: get_program_status listed a program Remove had taken away as `status: "active"` (it read a marker only the
 * connector's old archive wrote), and get_onboarding_status decided "has a program" from any queue doc that was not
 * marked archived, so a removed or paused program read wrongly. Now both read the person's own list through the
 * gateway's pinned copy of the app's plan-state rule.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { DocumentSnapshot, QueryDocumentSnapshot } from "firebase-admin/firestore";
import {
  NO_RUNNING_PROGRAM_MESSAGE,
  entriesByQueueId,
  heldPlanQueueIdOf,
  programStatusOf,
  summarizeProgram,
} from "../../shared/program-utils.js";
import { registerGetProgramStatus, type ProgramStatusDeps } from "../get_program_status.js";
import { registerGetOnboardingStatus, type OnboardingStatusDeps } from "../get_onboarding_status.js";
import { TEST_CLAIMS, captureLogs, openToolSession } from "./mcp_harness.js";

type Raw = Record<string, unknown>;

const REMOVED_AT = "2026-10-20T01:00:00.000Z";
const ID_RUN = "queue_run_20261012_090000";
const ID_PAUSED = "queue_paused_20261001_090000";
const ID_REMOVED = "queue_removed_20260925_090000";
const ID_REPLACED = "queue_replaced_20260910_090000";

const runningEntry = { queue_id: ID_RUN, methodology_id: "ai_gen", is_active: true };
const pausedEntry = { queue_id: ID_PAUSED, methodology_id: "ai_gen", is_active: false, pause_reason: "user_paused" };
const restingEntry = { queue_id: ID_PAUSED, methodology_id: "ai_gen", is_active: false, pause_reason: "inactive_21_days" };
const removedEntry = { queue_id: ID_REMOVED, methodology_id: "ai_gen", is_active: false, removed_at: REMOVED_AT };
const replacedEntry = { queue_id: ID_REPLACED, methodology_id: "ai_gen", is_active: false, superseded_by: ID_RUN };
const manualEntry = { queue_id: "manual_workouts", methodology_id: "manual", is_active: true };

// ── M2: programStatusOf ──────────────────────────────────────────────────────

test("programStatusOf: a removed program is never active, whatever the entry or an old marker says", () => {
  assert.equal(programStatusOf({ generation_status: "removed" }, runningEntry), "removed", "the queue says removed, the entry is stale");
  assert.equal(programStatusOf({ generation_status: "discarded" }, runningEntry), "removed");
  assert.equal(programStatusOf({ generation_status: "removed" }, undefined), "removed");
  assert.equal(programStatusOf({ generation_status: "complete" }, removedEntry), "removed", "Remove's entry mark alone is enough");
  assert.equal(programStatusOf({}, { ...removedEntry, removed_at: "  " }), "paused", "a blank mark is not a removal");
});

test("programStatusOf: replaced, paused, resting, running, and not in the list", () => {
  assert.equal(programStatusOf({}, replacedEntry), "replaced");
  assert.equal(programStatusOf({}, { queue_id: "q", retired_at: REMOVED_AT }), "replaced");
  assert.equal(programStatusOf({}, pausedEntry), "paused");
  assert.equal(programStatusOf({}, { queue_id: "q", is_active: false }), "paused", "inactive with no reason is the person's pause");
  assert.equal(programStatusOf({}, restingEntry), "resting");
  assert.equal(programStatusOf({ generation_status: "complete" }, runningEntry), "active");
  assert.equal(programStatusOf({}, undefined), "not_running");
});

test("programStatusOf: the old status:archived marker is no longer read; the app's list decides", () => {
  assert.equal(programStatusOf({ status: "archived", archived_at: REMOVED_AT }, runningEntry), "active");
  assert.equal(programStatusOf({ status: "archived" }, pausedEntry), "paused");
  assert.equal(programStatusOf({ status: "archived" }, undefined), "not_running");
});

test("entriesByQueueId and heldPlanQueueIdOf: the newest held program, never the manual container or a retired one", () => {
  const profile = { active_queues: [replacedEntry, removedEntry, runningEntry, manualEntry] };
  assert.deepEqual([...entriesByQueueId(profile).keys()].sort(), [ID_REMOVED, ID_REPLACED, ID_RUN, "manual_workouts"].sort());
  assert.equal(heldPlanQueueIdOf(profile), ID_RUN);
  assert.equal(heldPlanQueueIdOf({ active_queues: [runningEntry, pausedEntry] }), ID_PAUSED, "the newest live entry is the last");
  assert.equal(heldPlanQueueIdOf({ active_queues: [replacedEntry, removedEntry, manualEntry] }), null);
  assert.equal(heldPlanQueueIdOf({ active_queues: [{ methodology_id: "ai_gen", is_active: true }] }), null, "an entry with no id has nothing to read");
  assert.equal(heldPlanQueueIdOf({}), null);
  assert.equal(heldPlanQueueIdOf(null), null);
});

// ── M2: summarizeProgram ─────────────────────────────────────────────────────

const doc = (id: string, data: Raw): QueryDocumentSnapshot & DocumentSnapshot => ({ id, data: () => data }) as never;

test("summarizeProgram: status from the app's list; removedAt from Remove's timestamp; no archivedAt", () => {
  const entries = entriesByQueueId({ active_queues: [removedEntry, runningEntry] });
  const removed = summarizeProgram(
    doc(ID_REMOVED, { title: "Old plan", generation_status: "removed", removed_at: { toDate: () => new Date(REMOVED_AT) }, status: "archived", archived_at: REMOVED_AT, sessions: [] }),
    entries,
  );
  assert.equal(removed.status, "removed");
  assert.equal(removed.removedAt, REMOVED_AT);
  assert.equal("archivedAt" in removed, false, "the dead marker is no longer reported");
  assert.equal(removed.generationStatus, "removed");

  const running = summarizeProgram(doc(ID_RUN, { title: "Now", sessions: [{ week_number: 1, is_completed: true }, { week_number: 1 }] }), entries);
  assert.equal(running.status, "active");
  assert.equal(running.removedAt, null);
  assert.equal(running.completedSessions, 1);
  assert.equal(running.completionPercent, 50);
});

// ── M2: get_program_status through the wire ──────────────────────────────────

function statusDeps(profileData: Raw, docs: Array<ReturnType<typeof doc>>, active: Array<ReturnType<typeof doc>> = []): ProgramStatusDeps {
  return {
    activePrograms: async () => ({ profileData, queueDocs: active }),
    history: async () => ({ profileData, docs }),
  };
}

async function statusReply(args: Record<string, unknown>, deps: ProgramStatusDeps) {
  const session = await openToolSession((server) => registerGetProgramStatus(server, deps));
  try {
    return (await captureLogs(() => session.call("get_program_status", args))).value;
  } finally {
    await session.close();
  }
}

test("get_program_status list_history never lists a removed program as active", async () => {
  const profile = { active_queues: [replacedEntry, removedEntry, pausedEntry, runningEntry] };
  const docs = [
    doc(ID_RUN, { title: "Running", sessions: [] }),
    doc(ID_PAUSED, { title: "Paused", sessions: [] }),
    doc(ID_REMOVED, { title: "Removed", generation_status: "removed", sessions: [] }),
    doc(ID_REPLACED, { title: "Replaced", sessions: [] }),
    doc("queue_stopped_20260801_090000", { title: "Stopped in the app", sessions: [] }),
  ];
  const reply = await statusReply({ action: "list_history" }, statusDeps(profile, docs));
  assert.equal(reply.isError, false);
  const programs = (JSON.parse(reply.text) as { programs: Array<{ title: string; status: string }> }).programs;
  assert.deepEqual(
    Object.fromEntries(programs.map((p) => [p.title, p.status])),
    { Running: "active", Paused: "paused", Removed: "removed", Replaced: "replaced", "Stopped in the app": "not_running" },
  );
  assert.equal(programs.filter((p) => p.status === "active").length, 1);
});

test("get_program_status get_current reads each running program's entry; an empty answer points to Profile", async () => {
  const profile = { active_queues: [runningEntry] };
  const running = await statusReply({ action: "get_current" }, statusDeps(profile, [], [doc(ID_RUN, { title: "Running", sessions: [] })]));
  assert.equal((JSON.parse(running.text) as { programs: Array<{ status: string }> }).programs[0].status, "active");

  const none = await statusReply({ action: "get_current" }, statusDeps({ active_queues: [pausedEntry] }, []));
  assert.equal(none.isError, false);
  assert.equal((JSON.parse(none.text) as { message: string }).message, NO_RUNNING_PROGRAM_MESSAGE);
  assert.equal(NO_RUNNING_PROGRAM_MESSAGE, "No running program found. If you paused one, it is in Pelaris under Profile with a Resume button.");
});

test("get_program_status: the empty answers and a failed read are logged with the pseudonym like every other answer", async () => {
  const empty = statusDeps({ active_queues: [] }, []);
  const failing: ProgramStatusDeps = {
    activePrograms: async () => { throw new Error("read failed"); },
    history: async () => { throw new Error("read failed"); },
  };
  const cases: Array<[string, ProgramStatusDeps, boolean]> = [
    ["get_current with nothing running", empty, true],
    ["list_history with no programs", empty, true],
    ["get_current when the read fails", failing, false],
  ];
  for (const [name, deps, success] of cases) {
    const args = { action: name.startsWith("list_history") ? "list_history" : "get_current" };
    const session = await openToolSession((server) => registerGetProgramStatus(server, deps));
    try {
      const { value, logs } = await captureLogs(() => session.call("get_program_status", args));
      assert.equal(value.isError, !success, name);
      const lines = logs.filter((l) => l.tool === "get_program_status");
      assert.equal(lines.length, 1, `${name}: exactly one tool_call line`);
      assert.equal(lines[0].userPseudonym, TEST_CLAIMS.sub, `${name}: the line names the pseudonym, not anonymous`);
      assert.equal(lines[0].success, success, name);
    } finally {
      await session.close();
    }
  }
});

/** A compiled module's code without its comments (the headers explain the old marker by name). */
const codeOf = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("get_active_program's empty answer is the same sentence (source), and no reader mentions the dead marker", () => {
  assert.match(codeOf("../get_active_program.js"), /NO_RUNNING_PROGRAM_MESSAGE/);
  assert.equal(codeOf("../get_active_program.js").includes("No active programs found"), false);
  for (const file of ["../get_program_status.js", "../get_onboarding_status.js", "../../shared/program-utils.js"]) {
    assert.doesNotMatch(codeOf(file), /archived/, `${file} no longer reads the archived marker`);
  }
});

// ── M1: get_onboarding_status uses the app's own rule ────────────────────────

function onboardingDeps(profile: Raw | null, queues: Record<string, Raw> = {}): OnboardingStatusDeps & { queueReads: string[] } {
  const queueReads: string[] = [];
  return {
    queueReads,
    readProfile: async () => profile,
    readQueue: async (_profileId, queueId) => {
      queueReads.push(queueId);
      return queues[queueId] ?? null;
    },
    hasConnectedDevice: async () => false,
  };
}

async function onboardingReply(deps: OnboardingStatusDeps, scope = TEST_CLAIMS.scope + " profile:read") {
  const session = await openToolSession((server) => registerGetOnboardingStatus(server, deps));
  try {
    return (await captureLogs(() => session.call("get_onboarding_status", {}, { ...TEST_CLAIMS, scope }))).value;
  } finally {
    await session.close();
  }
}

const INTAKE = { currentIntakeRunId: "run_1" };
const ONBOARDING: Array<[string, Raw, boolean, string]> = [
  ["a running program", { ...INTAKE, active_queues: [runningEntry] }, true, "train_today"],
  ["a paused program (still theirs)", { ...INTAKE, active_queues: [pausedEntry] }, true, "train_today"],
  ["a rested program (still theirs)", { ...INTAKE, active_queues: [restingEntry] }, true, "train_today"],
  ["a removed program", { ...INTAKE, active_queues: [removedEntry] }, false, "generate_program"],
  ["replaced then removed", { ...INTAKE, active_queues: [replacedEntry, removedEntry] }, false, "generate_program"],
  ["only the manual-workouts container", { ...INTAKE, active_queues: [manualEntry] }, false, "generate_program"],
  ["no program and no intake", {}, false, "complete_intake"],
  ["a program and no intake marker", { active_queues: [runningEntry] }, true, "train_today"],
];

for (const [name, profile, hasProgram, nextStep] of ONBOARDING) {
  test(`get_onboarding_status: ${name} -> hasProgram ${hasProgram}, next_step ${nextStep}`, async () => {
    const reply = await onboardingReply(onboardingDeps(profile));
    assert.equal(reply.isError, false);
    const parsed = JSON.parse(reply.text) as { hasProgram: boolean; next_step: string };
    assert.equal(parsed.hasProgram, hasProgram);
    assert.equal(parsed.next_step, nextStep);
  });
}

test("get_onboarding_status: sport comes from the held program's own queue, read once; nothing is read otherwise", async () => {
  const queues: Record<string, Raw> = {
    [ID_RUN]: { methodology_id: "running_base", sport: "running" },
    [ID_REMOVED]: { methodology_id: "strength_x", sport: "strength" },
  };
  const held = onboardingDeps({ ...INTAKE, active_queues: [removedEntry, runningEntry] }, queues);
  const reply = await onboardingReply(held);
  assert.equal((JSON.parse(reply.text) as { sport: string }).sport, "running");
  assert.deepEqual(held.queueReads, [ID_RUN], "the removed program's queue is never consulted");

  const fromMethodology = onboardingDeps({ active_queues: [runningEntry] }, { [ID_RUN]: { methodology_id: "hybrid_base" } });
  assert.equal((JSON.parse((await onboardingReply(fromMethodology)).text) as { sport: string }).sport, "hybrid");

  const known = onboardingDeps({ intakeSummary: { primaryGoal: "marathon" }, active_queues: [runningEntry] }, queues);
  assert.equal((JSON.parse((await onboardingReply(known)).text) as { sport: string }).sport, "marathon");
  assert.deepEqual(known.queueReads, [], "a known sport needs no queue read");

  const none = onboardingDeps({ ...INTAKE, active_queues: [removedEntry] }, queues);
  assert.equal((JSON.parse((await onboardingReply(none)).text) as { sport: unknown }).sport, null);
  assert.deepEqual(none.queueReads, [], "no held program, no queue read");

  const missingDoc = onboardingDeps({ active_queues: [runningEntry] }, {});
  assert.equal((JSON.parse((await onboardingReply(missingDoc)).text) as { sport: unknown }).sport, null);
});

test("get_onboarding_status: a missing profile and a missing scope are refused as before", async () => {
  const missing = await onboardingReply(onboardingDeps(null));
  assert.equal(missing.isError, true);
  assert.equal(missing.text, "Profile not found");
  const scope = await onboardingReply(onboardingDeps({}), "training:read");
  assert.equal(scope.text, "Error: profile:read scope required");
});

test("get_onboarding_status source: no queue-collection scan, no archived filter, the shared facts", () => {
  const source = codeOf("../get_onboarding_status.js");
  assert.doesNotMatch(source, /"queues"\)\s*\.limit/);
  assert.doesNotMatch(source, /!==\s*"archived"/);
  assert.match(source, /onboardingFactsOf\(d\)/);
});
