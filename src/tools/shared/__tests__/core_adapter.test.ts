/**
 * Unit tests for core_adapter.ts (node:test, no extra dependencies; the repo
 * has no vitest/jest setup). Run after build: node --test dist/tools/shared/__tests__/
 *
 * The contract tests assert every legacy field lands on the exact core field
 * name with correct units, because the server silently ignores unknown keys.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type CoreWriteExerciseSpec,
  bridgeFailureResponse,
  coreWriteBlockSchema,
  coreWriteExerciseSchema,
  flatExercisesToBlocks,
  mapLegacyLoggedExercise,
  mapLegacyPlannedExercise,
  resolveBlocksInput,
  secondsToDurationMinutes,
  unwrapBridgeResult,
} from "../core_adapter.js";
import type { BridgeResult } from "../bridge_client.js";

/** Exactly the exercise field names the core write contract persists. */
const CORE_EXERCISE_FIELDS = new Set([
  "name", "exerciseId", "sets", "reps", "weightKg", "durationMinutes",
  "distanceMeters", "restSeconds", "rpe", "pace", "zone", "strokeType",
  "cue", "notes",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Unit conversion
// ─────────────────────────────────────────────────────────────────────────────

test("secondsToDurationMinutes converts exactly, preserving fractions", () => {
  assert.equal(secondsToDurationMinutes(90), 1.5);
  assert.equal(secondsToDurationMinutes(60), 1);
  assert.equal(secondsToDurationMinutes(0), 0);
  assert.equal(secondsToDurationMinutes(3600), 60);
  assert.equal(secondsToDurationMinutes(45), 0.75);
});

// ─────────────────────────────────────────────────────────────────────────────
// Legacy planned dialect (create_planned_session): weight / duration / distance
// ─────────────────────────────────────────────────────────────────────────────

test("mapLegacyPlannedExercise maps every legacy field onto the core name", () => {
  const spec = mapLegacyPlannedExercise({
    name: "Barbell Bench Press",
    exerciseId: "wger_0192",
    sets: 4,
    reps: 8,
    weight: 80,
    duration: 90,
    distance: 400,
    notes: "pause at chest",
  });
  assert.deepEqual(spec, {
    name: "Barbell Bench Press",
    exerciseId: "wger_0192",
    sets: 4,
    reps: 8,
    weightKg: 80,
    durationMinutes: 1.5,
    distanceMeters: 400,
    notes: "pause at chest",
  });
});

test("mapLegacyPlannedExercise preserves zero values", () => {
  const spec = mapLegacyPlannedExercise({ name: "Plank", weight: 0, duration: 0, distance: 0 });
  assert.equal(spec.weightKg, 0);
  assert.equal(spec.durationMinutes, 0);
  assert.equal(spec.distanceMeters, 0);
});

test("mapLegacyPlannedExercise omits absent fields entirely", () => {
  const spec = mapLegacyPlannedExercise({ name: "Push-up" });
  assert.deepEqual(Object.keys(spec), ["name"]);
});

test("mapLegacyPlannedExercise emits only core contract field names", () => {
  const spec = mapLegacyPlannedExercise({
    name: "Row", exerciseId: "wger_0001", sets: 3, reps: 10,
    weight: 60, duration: 120, distance: 1000, notes: "n",
  });
  for (const key of Object.keys(spec)) {
    assert.ok(CORE_EXERCISE_FIELDS.has(key), `unexpected key ${key}`);
  }
  assert.ok(!("weight" in spec), "legacy 'weight' must not pass through");
  assert.ok(!("duration" in spec), "legacy 'duration' must not pass through");
  assert.ok(!("distance" in spec), "legacy 'distance' must not pass through");
});

// ─────────────────────────────────────────────────────────────────────────────
// Legacy logged dialect (log_workout / log_completed_session / update_session)
// ─────────────────────────────────────────────────────────────────────────────

test("mapLegacyLoggedExercise maps every legacy field onto the core name", () => {
  const spec = mapLegacyLoggedExercise({
    name: "Weighted Chin-up",
    exerciseId: "ai_ex_weighted_chin_up",
    sets: 3,
    reps: 6,
    weightKg: 20,
    durationSec: 45,
    distanceMeters: 200,
    notes: "full hang",
  });
  assert.deepEqual(spec, {
    name: "Weighted Chin-up",
    exerciseId: "ai_ex_weighted_chin_up",
    sets: 3,
    reps: 6,
    weightKg: 20,
    durationMinutes: 0.75,
    distanceMeters: 200,
    notes: "full hang",
  });
});

test("mapLegacyLoggedExercise preserves zero values and omits absent fields", () => {
  const zeroSpec = mapLegacyLoggedExercise({ name: "Dead Hang", weightKg: 0, durationSec: 0 });
  assert.equal(zeroSpec.weightKg, 0);
  assert.equal(zeroSpec.durationMinutes, 0);
  const bareSpec = mapLegacyLoggedExercise({ name: "Air Squat" });
  assert.deepEqual(Object.keys(bareSpec), ["name"]);
  assert.ok(!("durationSec" in zeroSpec), "legacy 'durationSec' must not pass through");
});

// ─────────────────────────────────────────────────────────────────────────────
// Flat-to-blocks mapping
// ─────────────────────────────────────────────────────────────────────────────

test("flatExercisesToBlocks wraps each exercise in its own explicit single block", () => {
  const exercises: CoreWriteExerciseSpec[] = [
    { name: "Back Squat", sets: 5, reps: 5 },
    { name: "Romanian Deadlift", sets: 3, reps: 8 },
    { name: "Leg Press", sets: 3, reps: 12 },
    { name: "Calf Raise", sets: 4, reps: 15 },
  ];
  const blocks = flatExercisesToBlocks(exercises);
  assert.equal(blocks.length, 4);
  for (const [i, block] of blocks.entries()) {
    assert.equal(block.structure, "single");
    assert.equal(block.semanticType, "main");
    assert.equal(block.exercises.length, 1);
    assert.equal(block.exercises[0].name, exercises[i].name);
  }
});

test("flatExercisesToBlocks on an empty list returns an empty list", () => {
  assert.deepEqual(flatExercisesToBlocks([]), []);
});

test("resolveBlocksInput: explicit blocks win over flat exercises", () => {
  const blocks = [{
    semanticType: "main" as const,
    structure: "superset" as const,
    rounds: 3,
    exercises: [{ name: "Barbell Bench Press" }, { name: "Weighted Chin-up" }],
  }];
  const resolved = resolveBlocksInput(blocks, [{ name: "Ignored" }]);
  assert.equal(resolved, blocks);
});

test("resolveBlocksInput: flat exercises map to per-exercise single blocks", () => {
  const resolved = resolveBlocksInput(undefined, [{ name: "Back Squat" }, { name: "Leg Press" }]);
  assert.ok(resolved);
  assert.equal(resolved.length, 2);
  assert.equal(resolved[0].structure, "single");
  assert.equal(resolved[1].structure, "single");
});

test("resolveBlocksInput: neither input returns undefined (field omitted)", () => {
  assert.equal(resolveBlocksInput(undefined, undefined), undefined);
  assert.equal(resolveBlocksInput([], []), undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared zod fragments
// ─────────────────────────────────────────────────────────────────────────────

test("coreWriteBlockSchema accepts a superset block and preserves structure", () => {
  const parsed = coreWriteBlockSchema.parse({
    semanticType: "main",
    structure: "superset",
    rounds: 4,
    exercises: [
      { name: "Barbell Bench Press", sets: 4, reps: 8, weightKg: 80, restSeconds: 90 },
      { name: "Weighted Chin-up", sets: 4, reps: 6, weightKg: 20 },
    ],
  });
  assert.equal(parsed.structure, "superset");
  assert.equal(parsed.rounds, 4);
  assert.equal(parsed.exercises.length, 2);
  assert.equal(parsed.exercises[0].weightKg, 80);
});

test("coreWriteBlockSchema rejects a block without semanticType or with an unknown structure", () => {
  assert.throws(() => coreWriteBlockSchema.parse({ exercises: [{ name: "Row" }] }));
  assert.throws(() => coreWriteBlockSchema.parse({
    semanticType: "main",
    structure: "giant_set",
    exercises: [{ name: "Row" }],
  }));
});

test("coreWriteExerciseSchema strips unknown keys so junk never crosses the bridge", () => {
  const parsed = coreWriteExerciseSchema.parse({
    name: "Freestyle",
    durationMinutes: 10,
    weight: 999,
    durationSec: 999,
  } as Record<string, unknown>);
  assert.deepEqual(Object.keys(parsed).sort(), ["durationMinutes", "name"]);
});

test("coreWriteExerciseSchema accepts string reps ranges and optional exerciseId", () => {
  const parsed = coreWriteExerciseSchema.parse({ name: "Goblet Squat", reps: "8-10", exerciseId: "wger_0043" });
  assert.equal(parsed.reps, "8-10");
  assert.equal(parsed.exerciseId, "wger_0043");
});

// ─────────────────────────────────────────────────────────────────────────────
// Bridge envelope mapping
// ─────────────────────────────────────────────────────────────────────────────

test("bridgeFailureResponse returns null on a successful envelope", () => {
  const bridged: BridgeResult = { ok: true, tool: "create_planned_session", result: { sessionId: "abc" } };
  assert.equal(bridgeFailureResponse(bridged, "creating planned session"), null);
});

test("bridgeFailureResponse maps ok:false to an MCP error with the message", () => {
  const bridged: BridgeResult = { ok: false, tool: "create_planned_session", error: "needs_disambiguation" };
  const response = bridgeFailureResponse(bridged, "creating planned session");
  assert.ok(response);
  assert.equal(response.isError, true);
  assert.equal(response.content[0].type, "text");
  assert.equal(response.content[0].text, "Error creating planned session: needs_disambiguation");
});

test("bridgeFailureResponse appends errorDetail as compact parseable JSON", () => {
  const errorDetail = { candidates: [{ exerciseId: "wger_0192", name: "Bench Press" }] };
  const bridged: BridgeResult = { ok: false, tool: "modify_session", error: "needs_disambiguation", errorDetail };
  const response = bridgeFailureResponse(bridged, "modifying session");
  assert.ok(response);
  const lines = response.content[0].text.split("\n");
  assert.equal(lines[0], "Error modifying session: needs_disambiguation");
  assert.deepEqual(JSON.parse(lines[1]), errorDetail);
});

test("bridgeFailureResponse treats ok:true with a null result as a failure", () => {
  const bridged: BridgeResult = { ok: true, tool: "log_session" };
  const response = bridgeFailureResponse(bridged, "logging session");
  assert.ok(response);
  assert.equal(response.isError, true);
  assert.equal(response.content[0].text, "Error logging session: unknown error");
});

test("unwrapBridgeResult returns the result on success and throws on failure", () => {
  const ok: BridgeResult = { ok: true, tool: "log_session", result: { sessionId: "abc", status: "completed" } };
  assert.deepEqual(unwrapBridgeResult(ok), { sessionId: "abc", status: "completed" });
  const failed: BridgeResult = { ok: false, tool: "log_session", error: "boom" };
  assert.throws(() => unwrapBridgeResult(failed), /failed bridge envelope/);
});
