/**
 * Contract tests for the swap_exercise -> core bridge mapping
 * (node:test, matching src/tools/shared/__tests__/core_adapter.test.ts).
 * Run after build: node --test dist/tools/user/__tests__/
 *
 * These assert the exact payload crossing the bridge (every legacy field
 * under its core field name, autoApply=false preserved, no profile identifier
 * ever sourced from tool params) and the mapping of the core output back onto
 * the legacy response shape (original/replacement, alternatives[].name, the
 * additive catalog exerciseId).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type SwapExerciseToolParams,
  buildSwapExerciseCoreInput,
  mapCoreSwapOutput,
} from "../swap_exercise.js";

test("minimal params produce only exerciseName", () => {
  const input = buildSwapExerciseCoreInput({ exerciseName: "Bench Press" });
  assert.deepEqual(input, { exerciseName: "Bench Press" });
});

test("every legacy field crosses the bridge under its core field name", () => {
  const input = buildSwapExerciseCoreInput({
    sessionId: "diary_abc123",
    exerciseName: "Barbell Squat",
    reason: "injury",
    autoApply: true,
  });
  assert.deepEqual(input, {
    exerciseName: "Barbell Squat",
    sessionId: "diary_abc123",
    reason: "injury",
    autoApply: true,
  });
});

test("autoApply=false is preserved, not dropped as falsy", () => {
  const input = buildSwapExerciseCoreInput({
    sessionId: "diary_abc123",
    exerciseName: "Deadlift",
    autoApply: false,
  });
  assert.equal(input.autoApply, false);
});

test("additive replacementName crosses the bridge", () => {
  const input = buildSwapExerciseCoreInput({
    sessionId: "diary_abc123",
    exerciseName: "Bench Press",
    autoApply: true,
    replacementName: "Dumbbell Bench Press",
  });
  assert.equal(input.replacementName, "Dumbbell Bench Press");
});

test("profile identifiers never cross from params into the core input", () => {
  const params = {
    exerciseName: "Bench Press",
    profileId: "forged_profile",
    profile_id: "forged_profile",
  } as unknown as SwapExerciseToolParams;
  const input = buildSwapExerciseCoreInput(params);
  assert.ok(!("profileId" in input), "profileId must come from claims, not params");
  assert.ok(!("profile_id" in input), "profile_id must come from claims, not params");
});

test("suggestions output maps to the legacy shape with additive exerciseId", () => {
  const output = mapCoreSwapOutput(
    {
      action: "suggestions",
      alternatives: [
        { rank: 1, exerciseName: "Dumbbell Bench Press", exerciseId: "wger_0100", rationale: "Same movement pattern" },
        { rank: 2, exerciseName: "Machine variation", rationale: "Guided motion alternative" },
      ],
      message: "Found 2 alternatives.",
    },
    { exerciseName: "Bench Press", reason: "equipment" },
  );
  assert.deepEqual(output, {
    action: "suggestions",
    original: "Bench Press",
    reason: "equipment",
    alternatives: [
      { rank: 1, name: "Dumbbell Bench Press", exerciseId: "wger_0100", rationale: "Same movement pattern" },
      { rank: 2, name: "Machine variation", rationale: "Guided motion alternative" },
    ],
    message: "Found 2 alternatives.",
  });
  // No sessionId anywhere: the legacy no-session shape omits the key.
  assert.ok(!("sessionId" in output));
});

test("suggestions output echoes the session and defaults reason to preference", () => {
  const output = mapCoreSwapOutput(
    {
      action: "suggestions",
      sessionId: "diary_abc123",
      alternatives: [],
      message: "Found 0 alternatives.",
    },
    { exerciseName: "Bench Press", sessionId: "diary_abc123" },
  );
  assert.equal(output.sessionId, "diary_abc123");
  assert.equal(output.reason, "preference");
});

test("swapped output maps to the legacy original/replacement shape", () => {
  const output = mapCoreSwapOutput(
    {
      action: "swapped",
      swappedFrom: "Bench Press",
      swappedTo: "Dumbbell Bench Press",
      sessionId: "diary_abc123",
      message: "Swapped \"Bench Press\" → \"Dumbbell Bench Press\" in diary_abc123.",
    },
    { exerciseName: "Bench Press", sessionId: "diary_abc123", reason: "injury", autoApply: true },
  );
  assert.deepEqual(output, {
    sessionId: "diary_abc123",
    action: "swapped",
    original: "Bench Press",
    replacement: "Dumbbell Bench Press",
    reason: "injury",
    message: "Swapped \"Bench Press\" → \"Dumbbell Bench Press\" in diary_abc123.",
  });
});

test("swapped output falls back to param values when core omits echoes", () => {
  const output = mapCoreSwapOutput(
    { action: "swapped", swappedTo: "Goblet Squat", message: "Swapped." },
    { exerciseName: "Barbell Squat", sessionId: "diary_abc123", autoApply: true },
  );
  assert.equal(output.original, "Barbell Squat");
  assert.equal(output.sessionId, "diary_abc123");
});
