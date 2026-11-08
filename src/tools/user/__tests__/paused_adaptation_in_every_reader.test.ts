/**
 * A paused program's note, with the plain link inside its text, comes back from every program-reading
 * tool, so whichever one the assistant picks, the person gets the way back. node:test, no network.
 * Fixtures are obviously fake.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { adaptationFieldsFor, adaptationNoteFor } from "../../shared/program-utils.js";
import { ENTRY_LINK_TRAIN } from "../../shared/entry_links.js";
import type { TrainingTruth, TruthProgram } from "../../shared/training_truth.js";
import { registerGetActiveProgram } from "../get_active_program.js";
import { registerGetProgramStatus, type ProgramStatusDeps } from "../get_program_status.js";
import { TEST_CLAIMS, captureLogs, openToolSession } from "./mcp_harness.js";

const READ_CLAIMS = { ...TEST_CLAIMS, scope: "training:read" };
const ID = "queue_fake_one";
const PAUSED_QUEUE = { title: "Fake Plan", jit_state: "paused_entitlement", sessions: [{ id: "s1", scheduled_date: "2026-11-20" }] };
const ACTIVE_QUEUE = { title: "Fake Plan", sessions: [{ id: "s1", scheduled_date: "2026-11-20" }] };

function truthProgram(): TruthProgram {
  return {
    queueId: ID,
    title: "Fake Plan",
    kind: "program",
    role: "primary",
    isPrimary: true,
    planState: "active",
    generationStatus: "complete",
    currentWeekSessions: [],
    completion: { sessionsCompleted: 0, sessionsTotal: 1, completionPercent: 0 },
    startsOn: null, endsOn: null, declaredWeeks: 4, builtThroughWeek: 1, currentWeek: 1,
    weekStartsOn: null, weekEndsOn: null, phase: null, phases: [], buildState: "fully_built",
    nextUnbuiltWeek: null, nextUnbuiltWeekStartsOn: null, schedule: [],
  } as unknown as TruthProgram;
}

function truth(): TrainingTruth {
  return {
    asOf: "2026-11-09T09:00:00.000Z", timezone: "UTC", today: "2026-11-09",
    week: { weekId: "2026-11-09", weekEndId: "2026-11-15", isCurrent: true },
    weekCounts: null, primaryQueueId: ID, programs: [truthProgram()],
  } as unknown as TrainingTruth;
}

function assertPausedNote(p: Record<string, unknown>, label: string) {
  assert.equal(p.adaptationState, "paused", label);
  assert.ok(String(p.adaptationNote).includes(ENTRY_LINK_TRAIN), `${label}: link inside the note text`);
  assert.equal(p.link, ENTRY_LINK_TRAIN, `${label}: separate link kept`);
  assert.doesNotMatch(String(p.adaptationNote), /—/, `${label}: no em dash`);
}

function assertActiveNoExtras(p: Record<string, unknown>, label: string) {
  assert.equal(p.adaptationState, "active", label);
  assert.equal("adaptationNote" in p, false, `${label}: no note`);
  assert.equal("link" in p, false, `${label}: no link`);
}

test("adaptationNoteFor puts the plain link in the sentence", () => {
  assert.equal(adaptationNoteFor(null), `Weekly adaptation is paused. Open Pelaris to pick it back up: ${ENTRY_LINK_TRAIN}`);
});

test("adaptationFieldsFor (shared by get_training_overview): paused carries the note; active carries nothing extra", () => {
  assertPausedNote(adaptationFieldsFor(PAUSED_QUEUE), "jit_state");
  assertPausedNote(adaptationFieldsFor({}, "paused"), "build state");
  assertActiveNoExtras(adaptationFieldsFor(ACTIVE_QUEUE), "active");
});

async function activeProgram(queue: Record<string, unknown>) {
  const session = await openToolSession((server) =>
    registerGetActiveProgram(server, { truth: async () => truth(), queueDocs: async () => ({ queueDocs: [{ id: ID, data: () => queue }] }) }));
  try {
    const reply = (await captureLogs(() => session.call("get_active_program", {}, READ_CLAIMS))).value;
    return (JSON.parse(reply.text) as { programs: Array<Record<string, unknown>> }).programs[0];
  } finally {
    await session.close();
  }
}

test("get_active_program: paused carries state, note and link; active carries no note", async () => {
  assertPausedNote(await activeProgram(PAUSED_QUEUE), "get_active_program paused");
  assertActiveNoExtras(await activeProgram(ACTIVE_QUEUE), "get_active_program active");
});

function fakeDoc(data: Record<string, unknown>) {
  return { id: ID, data: () => data, exists: true } as unknown as FirebaseFirestore.QueryDocumentSnapshot;
}

async function statusPrograms(action: string, queue: Record<string, unknown>) {
  const profileData = { active_queues: [{ queue_id: ID, is_active: true, methodology_id: "fake" }] };
  const d = fakeDoc(queue);
  const deps: ProgramStatusDeps = {
    activePrograms: async () => ({ profileData, queueDocs: [d] }),
    history: async () => ({ profileData, docs: [d] }),
  };
  const session = await openToolSession((server) => registerGetProgramStatus(server, deps));
  try {
    const reply = (await captureLogs(() => session.call("get_program_status", { action }, READ_CLAIMS))).value;
    return (JSON.parse(reply.text) as { programs: Array<Record<string, unknown>> }).programs[0];
  } finally {
    await session.close();
  }
}

test("get_program_status: both actions carry the paused note; an active queue carries none", async () => {
  for (const action of ["get_current", "list_history"]) {
    assertPausedNote(await statusPrograms(action, PAUSED_QUEUE), `get_program_status ${action} paused`);
    assertActiveNoExtras(await statusPrograms(action, ACTIVE_QUEUE), `get_program_status ${action} active`);
  }
});
