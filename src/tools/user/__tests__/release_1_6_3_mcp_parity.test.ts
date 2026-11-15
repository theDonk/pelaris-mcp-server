/**
 * Parity tests for intake continuation links, timed holds, cardio calibration
 * bounds, cardioTargetMode preference updates, session match metadata, and
 * athlete challenge / lift recency context.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { McpTokenClaims } from "../../../auth.js";

const capturedRequests: Array<Record<string, unknown>> = [];
let respondWith: Record<string, unknown> = {};

const bridgeStub = http.createServer((req, res) => {
  let data = "";
  req.on("data", (chunk) => {
    data += chunk;
  });
  req.on("end", () => {
    capturedRequests.push(JSON.parse(data) as Record<string, unknown>);
    res.writeHead(200, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify(respondWith));
  });
});
await new Promise<void>((resolve) => bridgeStub.listen(0, "127.0.0.1", resolve));
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:1";
process.env.CF_BASE_URL = `http://127.0.0.1:${(bridgeStub.address() as AddressInfo).port}`;

const { shapeCompleteIntakeResult } = await import("../complete_intake.js");
const { ENTRY_LINK_PROGRAM } = await import("../../shared/entry_links.js");
const { mapDiarySessionSet } = await import("../get_session_details.js");
const {
  coreWriteExerciseSchema,
  mapLegacyLoggedExercise,
  mapLegacyPlannedExercise,
} = await import("../../shared/core_adapter.js");
const { registerRecordBenchmark, IMPLAUSIBLE_CALIBRATION_TEXT } = await import("../record_benchmark.js");
const { buildDirectProfileUpdates, CARDIO_TARGET_MODES } = await import("../update_user_profile.js");
const { mapLogWorkoutResult } = await import("../log_workout.js");
const { mapLogCompletedSessionResult } = await import("../log_completed_session.js");
const {
  buildAthleteChallengeFacts,
  recommendStartingWeightFromSimilarLifts,
} = await import("../../shared/challenge_facts.js");
const { runWithAuth } = await import("../../../request-context.js");
const { hasDash } = await import("./mcp_harness.js");

after(() => {
  bridgeStub.closeAllConnections?.();
  bridgeStub.close();
});

const claims: McpTokenClaims = {
  sub: "pseudonym_test",
  scope: "health:write training:write",
  platform: "test",
  profile_id: "profile_test_parity",
  exp: 0,
  iat: 0,
};

type BenchmarkHandler = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function benchmarkHandler(): BenchmarkHandler {
  let captured: BenchmarkHandler | null = null;
  const fakeServer = {
    registerTool: (_name: string, _config: unknown, h: unknown) => {
      captured = h as BenchmarkHandler;
    },
  };
  registerRecordBenchmark(fakeServer as never);
  assert.ok(captured, "record_benchmark handler captured");
  return captured as BenchmarkHandler;
}

test("complete_intake attaches program link and nextStep guidance without dashes", () => {
  const shaped = shapeCompleteIntakeResult({
    status: "completed",
    message: "Intake saved.",
    recommendedDurationWeeks: 12,
    goals: ["Run a sub-45 10K"],
  });
  assert.equal(shaped.status, "completed");
  assert.equal(shaped.continuationUrl, ENTRY_LINK_PROGRAM);
  assert.equal(typeof shaped.nextStep, "string");
  assert.ok(String(shaped.nextStep).includes(ENTRY_LINK_PROGRAM));
  assert.equal(hasDash(String(shaped.nextStep)), false);
});

test("timed holds map targetDurationSec / actualDurationSec and render as 45s hold instead of 1 reps", () => {
  const parsed = coreWriteExerciseSchema.parse({ name: "Plank", sets: 3, targetDurationSec: 45 });
  assert.equal(parsed.targetDurationSec, 45);

  const planned = mapLegacyPlannedExercise({ name: "Plank", sets: 3, targetDurationSec: 45 });
  assert.equal(planned.targetDurationSec, 45);

  const loggedTarget = mapLegacyLoggedExercise({ name: "Dead Hang", sets: 3, targetDurationSec: 60 });
  assert.equal(loggedTarget.targetDurationSec, 60);

  const loggedActual = mapLegacyLoggedExercise({ name: "Side Plank", sets: 2, actualDurationSec: 40 });
  assert.equal(loggedActual.targetDurationSec, 40);

  const formattedHold = mapDiarySessionSet({
    type: "strength",
    target_reps: 1,
    target_duration_sec: 45,
    actual_duration_sec: 45,
    isCompleted: true,
  });
  assert.equal(formattedHold.summary, "45s hold");
  assert.equal(formattedHold.targetDurationSec, 45);
  assert.equal(formattedHold.actualDurationSec, 45);
  assert.equal(formattedHold.targetReps, null);
  assert.equal(String(formattedHold.summary).includes("1 reps"), false);

  const normalStrength = mapDiarySessionSet({
    type: "strength",
    target_weight_kg: 100,
    target_reps: 5,
    target_rpe: 8,
    isCompleted: false,
  });
  assert.equal("summary" in normalStrength, false);
  assert.equal("targetDurationSec" in normalStrength, false);
  assert.equal(normalStrength.targetReps, 5);
});

test("record_benchmark validates cardio calibration bounds before hitting core bridge and maps core refusal", async () => {
  const before = capturedRequests.length;
  const badPace = await runWithAuth(claims, () =>
    benchmarkHandler()({ benchmarkName: "threshold_pace", value: 90, unit: "sec/km" }),
  );
  assert.equal(badPace.isError, true);
  assert.ok(badPace.content[0].text.includes("135"));
  assert.equal(capturedRequests.length, before);

  const badLthr = await runWithAuth(claims, () =>
    benchmarkHandler()({ benchmarkName: "LTHR", value: 250, unit: "bpm" }),
  );
  assert.equal(badLthr.isError, true);
  assert.equal(capturedRequests.length, before);

  const badMaxHr = await runWithAuth(claims, () =>
    benchmarkHandler()({ benchmarkName: "max_hr_bpm", value: 90, unit: "bpm" }),
  );
  assert.equal(badMaxHr.isError, true);
  assert.equal(capturedRequests.length, before);

  respondWith = { ok: false, tool: "update_athlete", error: "implausible_calibration_value" };
  const aliasRefused = await runWithAuth(claims, () =>
    benchmarkHandler()({ benchmarkName: "My Anaerobic Threshold", value: 25, unit: "bpm" }),
  );
  assert.equal(aliasRefused.isError, true);
  assert.equal(aliasRefused.content[0].text, IMPLAUSIBLE_CALIBRATION_TEXT);

  respondWith = {
    ok: true,
    tool: "update_athlete",
    result: { type: "benchmark", benchmarkId: "lthr_bpm", newValue: 171, previousValue: 168 },
  };
  const validLthr = await runWithAuth(claims, () =>
    benchmarkHandler()({ benchmarkName: "lthr_bpm", value: 171, unit: "bpm" }),
  );
  assert.notEqual(validLthr.isError, true);
  assert.equal(capturedRequests.length, before + 2);
});

test("update_user_profile writes cardioTargetMode and coach origin", () => {
  assert.deepEqual([...CARDIO_TARGET_MODES], ["pace", "heart_rate", "smart_hybrid"]);
  const { updates, updatedFields } = buildDirectProfileUpdates({ cardioTargetMode: "heart_rate" });
  assert.deepEqual(updates, {
    "preferences.cardio_target_mode": "heart_rate",
    "field_origins.cardio_target_mode": "coach",
  });
  assert.deepEqual(updatedFields, ["cardioTargetMode"]);
});

test("log_workout and log_completed_session forward matchingPlannedSession when present", () => {
  const match = {
    plannedSessionId: "sess_tempo_1",
    title: "Tempo Run",
    scheduledDate: "2026-11-12",
    confidence: "high",
  };
  const base = {
    sessionId: "diary_10",
    status: "completed",
    date: "2026-11-12",
    sport: "running",
    durationMinutes: 45,
    rpe: 7,
    exerciseCount: 0,
    dataQuality: "quick",
    message: "Logged session.",
    matchingPlannedSession: match,
    suggestedPlannedSessionMatch: match,
  };
  const w = mapLogWorkoutResult(base, false);
  const c = mapLogCompletedSessionResult(base);
  assert.deepEqual(w.matchingPlannedSession, match);
  assert.deepEqual(c.matchingPlannedSession, match);

  const { matchingPlannedSession: _a, suggestedPlannedSessionMatch: _b, ...withoutMatch } = base;
  assert.equal("matchingPlannedSession" in mapLogWorkoutResult(withoutMatch, false), false);
  assert.equal("matchingPlannedSession" in mapLogCompletedSessionResult(withoutMatch), false);
});

test("challenge facts and similar-lift recommendation apply bounded recency decay without dashes", () => {
  const fresh = recommendStartingWeightFromSimilarLifts({
    targetExerciseName: "Romanian Deadlift",
    loggedLifts: [{ exerciseName: "Conventional Deadlift", estimatedOneRepMaxKg: 180, daysAgo: 7 }],
    now: new Date("2026-11-15T00:00:00Z"),
  })!;
  assert.equal(fresh.recencyDecayFactor, 1);
  assert.equal(fresh.decayedEstimated1RmKg, 180);

  const stale = recommendStartingWeightFromSimilarLifts({
    targetExerciseName: "Romanian Deadlift",
    loggedLifts: [{ exerciseName: "Conventional Deadlift", estimatedOneRepMaxKg: 180, daysAgo: 64 }],
    now: new Date("2026-11-15T00:00:00Z"),
  })!;
  assert.equal(stale.recencyDecayFactor, 0.9);
  assert.equal(stale.decayedEstimated1RmKg, 162);
  assert.ok(stale.recommendedWeightKg < fresh.recommendedWeightKg);
  assert.equal(hasDash(stale.rationale), false);

  const injuredFacts = buildAthleteChallengeFacts({
    sport: "running",
    hasActiveInjury: true,
    completedSessionsLast28d: 8,
    plannedSessionsLast28d: 12,
  });
  assert.equal(injuredFacts.hasActiveInjury, true);
  assert.ok(injuredFacts.suggestedChallenges.some((c) => c.category === "recovery_mobility"));
  assert.equal(hasDash(JSON.stringify(injuredFacts)), false);
});
