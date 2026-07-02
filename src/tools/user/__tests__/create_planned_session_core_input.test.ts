/**
 * Contract tests for the create_planned_session -> core bridge input mapping
 * (node:test, matching src/tools/shared/__tests__/core_adapter.test.ts).
 * Run after build: node --test dist/tools/user/__tests__/
 *
 * These assert the exact payload crossing the bridge: every legacy field on
 * the core field name with correct units, flat exercises wrapped as explicit
 * single blocks, explicit blocks passing through untouched, and no profile
 * identifier ever sourced from tool params.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type CreatePlannedSessionToolParams,
  buildCreatePlannedSessionCoreInput,
} from "../create_planned_session.js";
import type { CoreWriteBlockSpec } from "../../shared/core_adapter.js";

test("minimal params produce only date and sport", () => {
  const input = buildCreatePlannedSessionCoreInput({ date: "2026-07-03", sport: "strength" });
  assert.deepEqual(input, { date: "2026-07-03", sport: "strength" });
});

test("every legacy flat exercise field lands in the core input with correct units", () => {
  const input = buildCreatePlannedSessionCoreInput({
    date: "2026-07-03",
    sport: "strength",
    exercises: [{
      name: "Barbell Bench Press",
      exerciseId: "wger_0192",
      sets: 4,
      reps: 8,
      weight: 80,
      duration: 90,
      distance: 400,
      notes: "pause at chest",
    }],
  });
  assert.deepEqual(input.blocks, [{
    semanticType: "main",
    structure: "single",
    exercises: [{
      name: "Barbell Bench Press",
      exerciseId: "wger_0192",
      sets: 4,
      reps: 8,
      weightKg: 80,
      durationMinutes: 1.5,
      distanceMeters: 400,
      notes: "pause at chest",
    }],
  }]);
  // Flat exercises always cross the bridge as explicit blocks, never as a
  // flat exercises[] the server could re-infer structure from.
  assert.ok(!("exercises" in input), "flat exercises[] must not cross the bridge");
});

test("flat exercises map to one explicit single block each", () => {
  const input = buildCreatePlannedSessionCoreInput({
    date: "2026-07-03",
    sport: "strength",
    exercises: [
      { name: "Back Squat", sets: 5, reps: 5 },
      { name: "Romanian Deadlift", sets: 3, reps: 8 },
      { name: "Leg Press", sets: 3, reps: 12 },
      { name: "Calf Raise", sets: 4, reps: 15 },
    ],
  });
  const blocks = input.blocks as CoreWriteBlockSpec[];
  assert.equal(blocks.length, 4);
  for (const block of blocks) {
    assert.equal(block.structure, "single");
    assert.equal(block.exercises.length, 1);
  }
});

test("explicit blocks pass through untouched and win over flat exercises", () => {
  const blocks: CoreWriteBlockSpec[] = [{
    semanticType: "main",
    structure: "superset",
    rounds: 4,
    exercises: [
      { name: "Barbell Bench Press", sets: 4, reps: 8, weightKg: 80, restSeconds: 90 },
      { name: "Weighted Chin-up", sets: 4, reps: 6, weightKg: 20 },
    ],
  }];
  const input = buildCreatePlannedSessionCoreInput({
    date: "2026-07-03",
    sport: "strength",
    exercises: [{ name: "Ignored", weight: 999 }],
    blocks,
  });
  assert.equal(input.blocks, blocks);
});

test("optional metadata fields are included only when present", () => {
  const full = buildCreatePlannedSessionCoreInput({
    date: "2026-07-03",
    sport: "running",
    title: "Threshold Run",
    durationMinutes: 45,
    sessionFocus: "Threshold Intervals",
    coachNote: "Builds on last week's tempo work",
  });
  assert.equal(full.title, "Threshold Run");
  assert.equal(full.durationMinutes, 45);
  assert.equal(full.sessionFocus, "Threshold Intervals");
  assert.equal(full.coachNote, "Builds on last week's tempo work");

  const minimal = buildCreatePlannedSessionCoreInput({ date: "2026-07-03", sport: "running" });
  assert.ok(!("title" in minimal));
  assert.ok(!("durationMinutes" in minimal));
  assert.ok(!("sessionFocus" in minimal));
  assert.ok(!("coachNote" in minimal));
});

test("empty exercises array omits blocks entirely", () => {
  const input = buildCreatePlannedSessionCoreInput({
    date: "2026-07-03",
    sport: "swimming",
    exercises: [],
  });
  assert.ok(!("blocks" in input));
});

test("profile identifiers never cross from params into the core input", () => {
  const params = {
    date: "2026-07-03",
    sport: "strength",
    profileId: "forged_profile",
    profile_id: "forged_profile",
  } as unknown as CreatePlannedSessionToolParams;
  const input = buildCreatePlannedSessionCoreInput(params);
  assert.ok(!("profileId" in input), "profileId must come from claims, not params");
  assert.ok(!("profile_id" in input), "profile_id must come from claims, not params");
});
