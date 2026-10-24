/**
 * generate_program is a reply-only tool (connector rev 2.1, Brad 20/10/2026, BRAD_RETURN #46): it writes nothing,
 * builds nothing, and answers with First Light's entry link. node:test, no extra dependencies, no Firestore, no
 * network: the profile read is injected, and the tool runs behind a real McpServer and a real client over the
 * SDK's in-memory transport, so these tests see what an assistant sees (including a stale client's old arguments).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GENERATE_PROGRAM_DESCRIPTION,
  GENERATE_PROGRAM_ERRORS,
  buildGenerateProgramReply,
  generateProgramStateOf,
  registerGenerateProgram,
  type GenerateProgramDeps,
} from "../generate_program.js";
import { ENTRY_LINK_PROGRAM, ENTRY_LINK_TRAIN } from "../../shared/entry_links.js";
import { TEST_CLAIMS, captureLogs, hasDash, openToolSession } from "./mcp_harness.js";

const LINK_PROGRAM = "https://coach.pelaris.io/start/program";
const LINK_TRAIN = "https://coach.pelaris.io/start/train";

const READY_TEXT =
  "Programs are built in Pelaris, where the athlete can see their program come together and shape it. " +
  "Their intake is done, so this link takes them straight to building their program. Share the link and " +
  "tell them it opens Pelaris. Please do not try to build the program in this chat. Planning a single " +
  "session or a week here is still fine.";
const NEEDS_INTAKE_TEXT =
  "Programs are built in Pelaris. First Pelaris needs a few answers about the athlete: their goal, " +
  "experience, training days, and any injuries or health conditions. You can ask them here and save " +
  "their answers with complete_intake, then call generate_program again for their link. Or share the " +
  "link now and they can answer the same questions inside Pelaris. Either way, the program itself is " +
  "built in Pelaris.";
const HAS_PROGRAM_TEXT =
  "This athlete already has a program in Pelaris (it may be paused), so there is nothing to build. " +
  "This link opens it on Today, where they can resume it if it is paused. Planning or changing " +
  "individual sessions here is still fine.";

// ── The links and the three replies, word for word ───────────────────────────

test("the two entry links are First Light's program and train tokens", () => {
  assert.equal(ENTRY_LINK_PROGRAM, LINK_PROGRAM);
  assert.equal(ENTRY_LINK_TRAIN, LINK_TRAIN);
});

test("ready_to_build: the program link and the fixed words", () => {
  assert.deepEqual(buildGenerateProgramReply("ready_to_build"), { state: "ready_to_build", link: LINK_PROGRAM, message: READY_TEXT });
});

test("needs_intake: the program link, and the assistant is told it can run the intake with complete_intake", () => {
  const reply = buildGenerateProgramReply("needs_intake");
  assert.deepEqual(reply, { state: "needs_intake", link: LINK_PROGRAM, message: NEEDS_INTAKE_TEXT });
  assert.ok(reply.message.includes("complete_intake"));
});

test("has_program: the train link, and the assistant is told there is nothing to build", () => {
  const reply = buildGenerateProgramReply("has_program");
  assert.deepEqual(reply, { state: "has_program", link: LINK_TRAIN, message: HAS_PROGRAM_TEXT });
  assert.ok(reply.message.includes("nothing to build"));
});

test("no reply has an em dash, and none promises a program built in the chat", () => {
  for (const state of ["ready_to_build", "needs_intake", "has_program"] as const) {
    const { message } = buildGenerateProgramReply(state);
    assert.equal(hasDash(message), false, state);
  }
  assert.equal(hasDash(GENERATE_PROGRAM_DESCRIPTION), false);
  assert.ok(GENERATE_PROGRAM_DESCRIPTION.includes("does not build one in this chat"));
});

// ── The state: the same two facts get_onboarding_status reads ────────────────

test("generateProgramStateOf: intake and program, all four combinations", () => {
  assert.equal(generateProgramStateOf({ hasCompletedOnboarding: false, hasProgram: false }), "needs_intake");
  assert.equal(generateProgramStateOf({ hasCompletedOnboarding: true, hasProgram: false }), "ready_to_build");
  assert.equal(generateProgramStateOf({ hasCompletedOnboarding: true, hasProgram: true }), "has_program");
  // A program already held wins, even before the intake marker is there (the app lands them on Today).
  assert.equal(generateProgramStateOf({ hasCompletedOnboarding: false, hasProgram: true }), "has_program");
});

// ── Through the wire: every reply state, from the profile shapes a connector sees ─

const INTAKE = { currentIntakeRunId: "run_1" };
const RUNNING = { queue_id: "queue_a_20261001_090000", methodology_id: "ai_gen", is_active: true };
const PAUSED = { queue_id: "queue_a_20261001_090000", methodology_id: "ai_gen", is_active: false, pause_reason: "user_paused" };
const RESTING = { queue_id: "queue_a_20261001_090000", methodology_id: "ai_gen", is_active: false, pause_reason: "inactive_21_days" };
const REMOVED = { queue_id: "queue_a_20261001_090000", methodology_id: "ai_gen", is_active: false, removed_at: "2026-10-20T01:00:00.000Z" };
const REPLACED = { queue_id: "queue_a_20261001_090000", methodology_id: "ai_gen", is_active: false, superseded_by: "queue_b_20261002_090000" };
const MANUAL = { queue_id: "manual_workouts", methodology_id: "manual", is_active: true };

function depsFor(profile: Record<string, unknown> | null): GenerateProgramDeps & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readProfile: async (profileId) => {
      reads.push(profileId);
      return profile;
    },
  };
}

async function replyFor(profile: Record<string, unknown> | null) {
  const deps = depsFor(profile);
  const session = await openToolSession((server) => registerGenerateProgram(server, deps));
  try {
    const { value, logs } = await captureLogs(() => session.call("generate_program", {}));
    return { reply: value, logs, reads: deps.reads };
  } finally {
    await session.close();
  }
}

const STATES: Array<[string, Record<string, unknown>, string, string]> = [
  ["a running program and the intake done", { ...INTAKE, active_queues: [RUNNING] }, "has_program", LINK_TRAIN],
  ["a running program and no intake marker", { active_queues: [RUNNING] }, "has_program", LINK_TRAIN],
  ["a paused program (it is still theirs)", { ...INTAKE, active_queues: [PAUSED] }, "has_program", LINK_TRAIN],
  ["a rested program (it is still theirs)", { ...INTAKE, active_queues: [RESTING] }, "has_program", LINK_TRAIN],
  ["only the manual-workouts container (not a program)", { ...INTAKE, active_queues: [MANUAL] }, "ready_to_build", LINK_PROGRAM],
  ["only a removed program (not a program)", { ...INTAKE, active_queues: [REMOVED] }, "ready_to_build", LINK_PROGRAM],
  ["a replaced program then a removed one (not a program)", { ...INTAKE, active_queues: [REPLACED, REMOVED] }, "ready_to_build", LINK_PROGRAM],
  ["no program and the intake done", { ...INTAKE }, "ready_to_build", LINK_PROGRAM],
  ["no program and no intake", {}, "needs_intake", LINK_PROGRAM],
  ["the manual container and no intake", { active_queues: [MANUAL] }, "needs_intake", LINK_PROGRAM],
];

for (const [name, profile, state, link] of STATES) {
  test(`through the wire: ${name} -> ${state}`, async () => {
    const { reply, reads } = await replyFor(profile);
    assert.equal(reply.isError, false);
    const parsed = JSON.parse(reply.text) as { state: string; link: string; message: string };
    assert.equal(parsed.state, state);
    assert.equal(parsed.link, link);
    assert.deepEqual(parsed, buildGenerateProgramReply(state as never));
    assert.deepEqual(reads, [TEST_CLAIMS.profile_id], "one read, of the token's own profile");
  });
}

test("the reply never carries a program id, a title or anything about the person's data", async () => {
  const { reply } = await replyFor({ ...INTAKE, name: "Secret Name", email: "someone@example.com", active_queues: [RUNNING] });
  for (const needle of ["queue_a_", "Secret", "someone@example.com", "profile_test_1"]) {
    assert.equal(reply.text.includes(needle), false, needle);
  }
});

// ── The old arguments, the registration, and what the tool may not contain ───

test("a stale assistant that still sends the old arguments gets the link, with no error (T13)", async () => {
  const deps = depsFor({ ...INTAKE });
  const session = await openToolSession((server) => registerGenerateProgram(server, deps));
  try {
    const { value } = await captureLogs(() =>
      session.call("generate_program", { goal: "sub-45 10k", durationWeeks: 12, sessionsPerWeek: 4, notes: "knee", programType: "running", startDate: "2026-11-02" }),
    );
    assert.equal(value.isError, false);
    assert.equal((JSON.parse(value.text) as { link: string }).link, LINK_PROGRAM);
  } finally {
    await session.close();
  }
});

test("registers under the same name as a read-only, idempotent tool with an empty input schema", async () => {
  const session = await openToolSession((server) => registerGenerateProgram(server, depsFor({})));
  try {
    const tool = await session.listedTool("generate_program");
    assert.ok(tool, "still listed");
    assert.equal(tool.title, "Start Your Program");
    assert.equal(tool.description, GENERATE_PROGRAM_DESCRIPTION);
    const annotations = tool.annotations as Record<string, unknown>;
    assert.equal(annotations.readOnlyHint, true);
    assert.equal(annotations.destructiveHint, false);
    assert.equal(annotations.idempotentHint, true);
    assert.equal(annotations.openWorldHint, false);
    const schema = tool.inputSchema as { properties?: Record<string, unknown> };
    assert.deepEqual(Object.keys(schema.properties ?? {}), []);
  } finally {
    await session.close();
  }
});

test("source contract: no build call, no network, no limiter, no Firestore write", () => {
  const source = readFileSync(new URL("../generate_program.js", import.meta.url), "utf8");
  const banned = [
    "generateProgramServer", "google-auth-library", "GoogleAuth", "CF_BASE_URL", "callCoreBridge", "axios",
    "checkGenerationRateLimit", "checkWriteRateLimit", "getIdTokenClient",
  ];
  for (const word of banned) assert.equal(source.includes(word), false, word);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\.(set|update|add|delete|create)\s*\(/);
  assert.doesNotMatch(source, /runTransaction|batch\s*\(/);
});

// ── Scope ────────────────────────────────────────────────────────────────────

test("training:read alone and training:write alone are both enough; another scope is not", async () => {
  const deps = depsFor({ ...INTAKE });
  const session = await openToolSession((server) => registerGenerateProgram(server, deps));
  try {
    const { value } = await captureLogs(async () => ({
      read: await session.call("generate_program", {}, { ...TEST_CLAIMS, scope: "training:read" }),
      write: await session.call("generate_program", {}, { ...TEST_CLAIMS, scope: "training:write" }),
      other: await session.call("generate_program", {}, { ...TEST_CLAIMS, scope: "profile:read goals:write" }),
      none: await session.call("generate_program", {}, null),
    }));
    assert.equal(value.read.isError, false);
    assert.equal(value.write.isError, false);
    assert.equal(value.other.isError, true);
    assert.equal(value.other.text, GENERATE_PROGRAM_ERRORS.scope);
    assert.equal(value.none.isError, true);
    assert.equal(deps.reads.length, 2, "a refused call reads nothing");
  } finally {
    await session.close();
  }
});

// ── Logging: the pseudonym on every path, including the catch; fixed sentences only ──

test("the pseudonym is logged on the success, scope, missing-profile and catch paths", async () => {
  const secret = "SECRET_firestore_path_profiles/abc123";
  const failing: GenerateProgramDeps = {
    readProfile: async () => {
      throw new Error(secret);
    },
  };
  const missing = depsFor(null);
  const ok = depsFor({ ...INTAKE, active_queues: [RUNNING] });

  const run = async (deps: GenerateProgramDeps, claims = TEST_CLAIMS) => {
    const session = await openToolSession((server) => registerGenerateProgram(server, deps));
    try {
      return await captureLogs(() => session.call("generate_program", {}, claims));
    } finally {
      await session.close();
    }
  };

  const success = await run(ok);
  const scope = await run(ok, { ...TEST_CLAIMS, scope: "profile:read" });
  const noProfile = await run(missing);
  const thrown = await run(failing);

  for (const [label, outcome] of Object.entries({ success, scope, noProfile, thrown })) {
    const lines = outcome.logs.filter((l) => l.tool === "generate_program");
    assert.equal(lines.length, 1, `${label}: exactly one tool_call line`);
    assert.equal(lines[0].userPseudonym, TEST_CLAIMS.sub, `${label}: the pseudonym, not "anonymous"`);
  }
  assert.equal(success.logs[0].success, true);
  assert.equal(success.logs[0].reply_state, "has_program");
  assert.equal(scope.logs[0].error, "scope_required");
  assert.equal(noProfile.logs[0].error, "profile_not_found");
  assert.equal(thrown.logs[0].error, "generate_program_failed");
  assert.equal(thrown.logs[0].error_name, "Error");

  // The athlete's assistant gets a fixed sentence, never the raw error; the log never carries it either.
  assert.equal(thrown.value.isError, true);
  assert.equal(thrown.value.text, GENERATE_PROGRAM_ERRORS.tryAgain);
  assert.equal(JSON.stringify(thrown.logs).includes(secret), false);
  assert.equal(thrown.value.text.includes("abc123"), false);
  assert.equal(noProfile.value.text, GENERATE_PROGRAM_ERRORS.profileMissing);
});
