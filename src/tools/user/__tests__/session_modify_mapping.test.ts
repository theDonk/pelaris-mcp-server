/**
 * Unit tests for session_modify_mapping.ts (node:test, no extra dependencies;
 * the repo has no vitest/jest setup). Run after build:
 * node --test dist/tools/user/__tests__/
 *
 * Contract tests: every legacy update_session / modify_training_session field
 * must land on the exact core field name with correct units, because the
 * server silently ignores unknown keys.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildModifyTrainingOperations,
  buildUpdateSessionCompletionInput,
  buildUpdateSessionMetadataInput,
  isCompletionRequest,
  listProvidedUpdateFields,
} from "../session_modify_mapping.js";

/** Exactly the keys the core modify_session type='metadata' contract reads. */
const MODIFY_METADATA_FIELDS = new Set([
  "type", "sessionId", "title", "sessionFocus", "durationMinutes", "status",
  "scheduledDate", "rpe", "feedbackTags", "feedbackNote", "exercises",
  "blocks", "replaceExercises", "coachNote",
]);

/** Exactly the keys the core log_session contract reads. */
const LOG_SESSION_FIELDS = new Set([
  "detailLevel", "plannedSessionId", "completedAsPrescribed", "sport", "date",
  "durationMinutes", "rpe", "title", "sessionFocus", "exercises", "feelings",
  "feedbackTags", "feedbackNote", "coachNote", "idempotencyKey",
]);

// ─────────────────────────────────────────────────────────────────────────────
// update_session -> modify_session type='metadata'
// ─────────────────────────────────────────────────────────────────────────────

test("buildUpdateSessionMetadataInput maps every legacy field onto the core name", () => {
  const input = buildUpdateSessionMetadataInput({
    sessionId: "sess_1",
    title: "Upper Body A",
    sessionFocus: "push strength",
    durationMinutes: 60,
    status: "planned",
    scheduledDate: "2026-07-03",
    rpe: 7,
    feedbackTags: ["felt_strong"],
    feedbackNote: "solid",
    coachNote: "keep the bar path tight",
    exercises: [{
      name: "Barbell Bench Press",
      exerciseId: "wger_0192",
      sets: 4,
      reps: 8,
      weightKg: 80,
      durationSec: 90,
      distanceMeters: 400,
    }],
  });
  assert.equal(input.type, "metadata");
  assert.equal(input.sessionId, "sess_1");
  assert.equal(input.title, "Upper Body A");
  assert.equal(input.sessionFocus, "push strength");
  assert.equal(input.durationMinutes, 60);
  assert.equal(input.status, "planned");
  assert.equal(input.scheduledDate, "2026-07-03");
  assert.equal(input.rpe, 7);
  assert.deepEqual(input.feedbackTags, ["felt_strong"]);
  assert.equal(input.feedbackNote, "solid");
  assert.equal(input.coachNote, "keep the bar path tight");
  // Legacy replace semantics carried explicitly.
  assert.equal(input.replaceExercises, true);
  // Exercises land in the core dialect: durationSec (seconds) -> durationMinutes.
  assert.deepEqual(input.exercises, [{
    name: "Barbell Bench Press",
    exerciseId: "wger_0192",
    sets: 4,
    reps: 8,
    weightKg: 80,
    durationMinutes: 1.5,
    distanceMeters: 400,
  }]);
  for (const key of Object.keys(input)) {
    assert.ok(MODIFY_METADATA_FIELDS.has(key), `unexpected key ${key}`);
  }
});

test("buildUpdateSessionMetadataInput omits absent fields and replaceExercises without exercises", () => {
  const input = buildUpdateSessionMetadataInput({ sessionId: "sess_1", rpe: 8 });
  assert.deepEqual(Object.keys(input).sort(), ["rpe", "sessionId", "type"]);
  assert.ok(!("replaceExercises" in input));
});

test("buildUpdateSessionMetadataInput passes structured blocks through untouched", () => {
  const blocks = [{
    semanticType: "main" as const,
    structure: "superset" as const,
    rounds: 3,
    exercises: [{ name: "Barbell Bench Press" }, { name: "Weighted Chin-up" }],
  }];
  const input = buildUpdateSessionMetadataInput({ sessionId: "sess_1", blocks });
  assert.equal(input.blocks, blocks);
});

// ─────────────────────────────────────────────────────────────────────────────
// update_session status='completed' -> log_session
// ─────────────────────────────────────────────────────────────────────────────

test("isCompletionRequest is true only for status completed", () => {
  assert.equal(isCompletionRequest({ sessionId: "s", status: "completed" }), true);
  assert.equal(isCompletionRequest({ sessionId: "s", status: "planned" }), false);
  assert.equal(isCompletionRequest({ sessionId: "s" }), false);
});

test("buildUpdateSessionCompletionInput without exercises completes as prescribed", () => {
  const input = buildUpdateSessionCompletionInput({
    sessionId: "sess_1",
    status: "completed",
    rpe: 8,
    feedbackTags: ["felt_strong"],
    feedbackNote: "great",
    coachNote: "nice work",
    durationMinutes: 55,
    title: "Upper Body A",
    sessionFocus: "push",
  });
  assert.equal(input.plannedSessionId, "sess_1");
  assert.equal(input.completedAsPrescribed, true);
  assert.equal(input.sport, "general");
  assert.equal(input.rpe, 8);
  assert.deepEqual(input.feedbackTags, ["felt_strong"]);
  assert.equal(input.feedbackNote, "great");
  assert.equal(input.coachNote, "nice work");
  assert.equal(input.durationMinutes, 55);
  assert.equal(input.title, "Upper Body A");
  assert.equal(input.sessionFocus, "push");
  assert.ok(!("exercises" in input));
  // status and scheduledDate never cross into log_session.
  assert.ok(!("status" in input));
  assert.ok(!("scheduledDate" in input));
  for (const key of Object.keys(input)) {
    assert.ok(LOG_SESSION_FIELDS.has(key), `unexpected key ${key}`);
  }
});

test("buildUpdateSessionCompletionInput with exercises maps units and disables the prescribed copy", () => {
  const input = buildUpdateSessionCompletionInput({
    sessionId: "sess_1",
    status: "completed",
    exercises: [{ name: "Row Erg", durationSec: 1200, distanceMeters: 5000 }],
  });
  assert.equal(input.completedAsPrescribed, false);
  assert.deepEqual(input.exercises, [{
    name: "Row Erg",
    durationMinutes: 20,
    distanceMeters: 5000,
  }]);
});

// ─────────────────────────────────────────────────────────────────────────────
// listProvidedUpdateFields
// ─────────────────────────────────────────────────────────────────────────────

test("listProvidedUpdateFields lists exactly the provided fields in legacy order", () => {
  assert.deepEqual(listProvidedUpdateFields({ sessionId: "s" }), []);
  assert.deepEqual(
    listProvidedUpdateFields({
      sessionId: "s",
      status: "completed",
      title: "T",
      exercises: [{ name: "Row" }],
      coachNote: "n",
    }),
    ["title", "status", "exercises", "coachNote"],
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// modify_training_session -> modify_session operations
// ─────────────────────────────────────────────────────────────────────────────

test("buildModifyTrainingOperations collapses volume + intensity into one scale operation", () => {
  const operations = buildModifyTrainingOperations({
    sessionId: "sess_1",
    reduceVolume: 0.75,
    increaseIntensity: 1.1,
  });
  assert.equal(operations.length, 1);
  assert.deepEqual(operations[0].input, {
    type: "scale",
    sessionId: "sess_1",
    volumeMultiplier: 0.75,
    intensityMultiplier: 1.1,
  });
});

test("buildModifyTrainingOperations maps swap onto the core swap shape with optional id", () => {
  const [bare] = buildModifyTrainingOperations({
    sessionId: "sess_1",
    swapExercise: { from: "Back Squat", to: "Leg Press" },
  });
  assert.deepEqual(bare.input, {
    type: "swap",
    sessionId: "sess_1",
    fromExercise: "Back Squat",
    toExercise: "Leg Press",
  });
  const [withId] = buildModifyTrainingOperations({
    sessionId: "sess_1",
    swapExercise: { from: "Back Squat", to: "Leg Press", toExerciseId: "wger_0113" },
  });
  assert.equal(withId.input.toExerciseId, "wger_0113");
});

test("buildModifyTrainingOperations maps reschedule and keeps the legacy apply order", () => {
  const operations = buildModifyTrainingOperations({
    sessionId: "sess_1",
    rescheduleDate: "2026-07-05",
    swapExercise: { from: "Back Squat", to: "Leg Press" },
    reduceVolume: 0.5,
  });
  assert.deepEqual(operations.map((op) => op.input.type), ["scale", "swap", "reschedule"]);
  assert.deepEqual(operations[2].input, {
    type: "reschedule",
    sessionId: "sess_1",
    newDate: "2026-07-05",
  });
});

test("buildModifyTrainingOperations with no modifications returns an empty list", () => {
  assert.deepEqual(buildModifyTrainingOperations({ sessionId: "sess_1" }), []);
});
