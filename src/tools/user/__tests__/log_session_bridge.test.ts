/**
 * Unit tests for the log_workout / log_completed_session bridge mappings
 * (node:test, no extra dependencies; the repo has no vitest/jest setup).
 * Run after build: node --test dist/tools/user/__tests__/
 *
 * Contract tests: every legacy field must land on the exact core
 * `log_session` field name with correct units (the server silently ignores
 * unknown keys), and the core output must map back onto each tool's legacy
 * response shape.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLogCompletedSessionCoreInput,
  mapLogCompletedSessionResult,
} from "../log_completed_session.js";
import {
  buildLogWorkoutCoreInput,
  mapLogWorkoutResult,
} from "../log_workout.js";

// ─────────────────────────────────────────────────────────────────────────────
// log_completed_session -> core log_session input
// ─────────────────────────────────────────────────────────────────────────────

test("log_completed_session: every legacy field lands on the core input", () => {
  const input = buildLogCompletedSessionCoreInput({
    plannedSessionId: "plan_123",
    date: "2026-06-30",
    sport: "strength",
    title: "Upper Body",
    sessionFocus: "chest and shoulders",
    durationMinutes: 60,
    rpe: 8,
    feedbackTags: ["felt_strong", "good_form"],
    feedbackNote: "solid session",
    coachNote: "great bar speed",
    exercises: [{
      name: "Barbell Bench Press",
      exerciseId: "wger_0192",
      sets: 4,
      reps: 8,
      weightKg: 80,
      durationSec: 90,
      distanceMeters: 200,
      notes: "pause at chest",
    }],
  });
  assert.deepEqual(input, {
    detailLevel: "detailed",
    sport: "strength",
    date: "2026-06-30",
    plannedSessionId: "plan_123",
    title: "Upper Body",
    sessionFocus: "chest and shoulders",
    durationMinutes: 60,
    rpe: 8,
    feedbackTags: ["felt_strong", "good_form"],
    feedbackNote: "solid session",
    coachNote: "great bar speed",
    exercises: [{
      name: "Barbell Bench Press",
      exerciseId: "wger_0192",
      sets: 4,
      reps: 8,
      weightKg: 80,
      durationMinutes: 1.5,
      distanceMeters: 200,
      notes: "pause at chest",
    }],
  });
});

test("log_completed_session: minimal params omit absent optional fields", () => {
  const input = buildLogCompletedSessionCoreInput({ date: "2026-06-30", sport: "running" });
  assert.deepEqual(input, {
    detailLevel: "detailed",
    sport: "running",
    date: "2026-06-30",
  });
});

test("log_completed_session: legacy exercise unit names never cross the bridge", () => {
  const input = buildLogCompletedSessionCoreInput({
    date: "2026-06-30",
    sport: "swimming",
    exercises: [{ name: "Freestyle", durationSec: 600, distanceMeters: 500 }],
  });
  const exercises = input.exercises as Array<Record<string, unknown>>;
  assert.equal(exercises[0].durationMinutes, 10);
  assert.ok(!("durationSec" in exercises[0]), "legacy 'durationSec' must not pass through");
});

// ─────────────────────────────────────────────────────────────────────────────
// log_workout -> core log_session input
// ─────────────────────────────────────────────────────────────────────────────

test("log_workout: every legacy field lands on the core input", () => {
  const input = buildLogWorkoutCoreInput({
    plannedSessionId: "session_abc",
    completedAsPrescribed: true,
    sport: "strength",
    duration: 45,
    rpe: 7.5,
    date: "2026-07-01",
    feelings: ["strong", "motivated"],
    notes: "felt fast today",
    exercises: [{
      name: "Weighted Chin-up",
      exerciseId: "ai_ex_weighted_chin_up",
      sets: 3,
      reps: 6,
      weightKg: 20,
      durationSec: 45,
      distanceMeters: 100,
      notes: "full hang",
    }],
  });
  assert.deepEqual(input, {
    detailLevel: "quick",
    sport: "strength",
    // Legacy top-level duration is already minutes: name change only.
    durationMinutes: 45,
    rpe: 7.5,
    plannedSessionId: "session_abc",
    completedAsPrescribed: true,
    date: "2026-07-01",
    feelings: ["strong", "motivated"],
    // Legacy `notes` is the session note: maps to core feedbackNote.
    feedbackNote: "felt fast today",
    exercises: [{
      name: "Weighted Chin-up",
      exerciseId: "ai_ex_weighted_chin_up",
      sets: 3,
      reps: 6,
      weightKg: 20,
      durationMinutes: 0.75,
      distanceMeters: 100,
      notes: "full hang",
    }],
  });
});

test("log_workout: sessionId is a plannedSessionId alias; plannedSessionId wins", () => {
  const aliasOnly = buildLogWorkoutCoreInput({
    sessionId: "session_alias",
    sport: "running",
    duration: 30,
    rpe: 6,
  });
  assert.equal(aliasOnly.plannedSessionId, "session_alias");

  const both = buildLogWorkoutCoreInput({
    sessionId: "session_alias",
    plannedSessionId: "session_primary",
    sport: "running",
    duration: 30,
    rpe: 6,
  });
  assert.equal(both.plannedSessionId, "session_primary");
});

test("log_workout: minimal params omit absent optional fields", () => {
  const input = buildLogWorkoutCoreInput({ sport: "cycling", duration: 90, rpe: 5 });
  assert.deepEqual(input, {
    detailLevel: "quick",
    sport: "cycling",
    durationMinutes: 90,
    rpe: 5,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// core log_session output -> log_completed_session legacy response shape
// ─────────────────────────────────────────────────────────────────────────────

test("log_completed_session result: core 'updated' maps to legacy completed_planned", () => {
  const mapped = mapLogCompletedSessionResult({
    sessionId: "diary_1",
    status: "updated",
    date: "2026-06-30",
    sport: "strength",
    title: "Upper Body",
    durationMinutes: 60,
    rpe: 8,
    exerciseCount: 4,
    dataQuality: "detailed",
    message: "Logged workout against planned session diary_1.",
  });
  assert.deepEqual(mapped, {
    sessionId: "diary_1",
    status: "completed_planned",
    date: "2026-06-30",
    sport: "strength",
    title: "Upper Body",
    message: "Planned session \"Upper Body\" marked as completed.",
  });
});

test("log_completed_session result: core 'completed' maps to legacy logged shape", () => {
  const mapped = mapLogCompletedSessionResult({
    sessionId: "diary_2",
    status: "completed",
    date: "2026-06-30",
    sport: "running",
    title: "Running Session",
    durationMinutes: 40,
    rpe: 6,
    exerciseCount: 0,
    dataQuality: "quick",
    message: "Logged new running session \"Running Session\" on 2026-06-30.",
  });
  assert.deepEqual(mapped, {
    sessionId: "diary_2",
    status: "logged",
    date: "2026-06-30",
    sport: "running",
    title: "Running Session",
    duration: 40,
    rpe: 6,
    exerciseCount: 0,
    dataQuality: "quick",
    message: "Logged new running session \"Running Session\" on 2026-06-30.",
  });
});

test("log_completed_session result: idempotency hit preserves core's no-duplicate message", () => {
  // Core currently reports an idempotency hit as status 'completed' with an
  // explanatory message; the message must cross verbatim so the agent knows
  // no duplicate was created. A future core 'already_logged' status maps
  // straight through.
  const hit = mapLogCompletedSessionResult({
    sessionId: "diary_3",
    status: "completed",
    date: "2026-06-30",
    sport: "strength",
    exerciseCount: 0,
    dataQuality: "quick",
    message: "Workout already logged (matching date, sport, and duration). No duplicate created.",
  });
  assert.equal(hit.status, "logged");
  assert.equal(hit.message, "Workout already logged (matching date, sport, and duration). No duplicate created.");

  const future = mapLogCompletedSessionResult({
    sessionId: "diary_3",
    status: "already_logged",
    message: "Workout already logged (matching date, sport, and duration). No duplicate created.",
  });
  assert.deepEqual(future, {
    sessionId: "diary_3",
    status: "already_logged",
    message: "Workout already logged (matching date, sport, and duration). No duplicate created.",
  });
});

test("log_completed_session result: missing duration and rpe map to null like legacy", () => {
  const mapped = mapLogCompletedSessionResult({
    sessionId: "diary_4",
    status: "completed",
    date: "2026-06-30",
    sport: "yoga",
    title: "Yoga Session",
    exerciseCount: 0,
    dataQuality: "quick",
    message: "Logged new yoga session \"Yoga Session\" on 2026-06-30.",
  });
  assert.equal(mapped.duration, null);
  assert.equal(mapped.rpe, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// core log_session output -> log_workout legacy response shape
// ─────────────────────────────────────────────────────────────────────────────

test("log_workout result: core 'updated' maps to legacy completed_planned", () => {
  const mapped = mapLogWorkoutResult({
    sessionId: "diary_5",
    status: "updated",
    date: "2026-07-01",
    sport: "strength",
    title: "Push Day",
    durationMinutes: 45,
    rpe: 7,
    exerciseCount: 5,
    dataQuality: "detailed",
    message: "Logged workout against planned session diary_5.",
  }, true);
  assert.deepEqual(mapped, {
    sessionId: "diary_5",
    status: "completed_planned",
    date: "2026-07-01",
    sport: "strength",
    duration: 45,
    rpe: 7,
    completedAsPrescribed: true,
    message: "Planned session \"diary_5\" marked as completed on 2026-07-01.",
  });
});

test("log_workout result: core 'completed' maps to legacy logged shape", () => {
  const mapped = mapLogWorkoutResult({
    sessionId: "diary_6",
    status: "completed",
    date: "2026-07-01",
    sport: "cycling",
    title: "Cycling Session",
    durationMinutes: 90,
    rpe: 5,
    exerciseCount: 0,
    dataQuality: "quick",
    message: "Logged new cycling session \"Cycling Session\" on 2026-07-01.",
  }, false);
  assert.deepEqual(mapped, {
    sessionId: "diary_6",
    status: "logged",
    date: "2026-07-01",
    sport: "cycling",
    duration: 90,
    rpe: 5,
    exerciseCount: 0,
    dataQuality: "quick",
    message: "Logged new cycling session \"Cycling Session\" on 2026-07-01.",
  });
});

test("log_workout result: 'already_logged' passes through the legacy shape", () => {
  const mapped = mapLogWorkoutResult({
    sessionId: "diary_7",
    status: "already_logged",
    message: "Workout already logged (matching date, sport, and duration). No duplicate created.",
  }, false);
  assert.deepEqual(mapped, {
    sessionId: "diary_7",
    status: "already_logged",
    message: "Workout already logged (matching date, sport, and duration). No duplicate created.",
  });
});
