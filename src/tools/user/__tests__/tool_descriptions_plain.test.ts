/**
 * Tool descriptions say what a tool does, what it returns and when to use it. They never name
 * another tool or tell the assistant how to behave: directories reject both as prompt-injection
 * patterns. Guidance for the assistant belongs in the tool's result. node:test, no Firestore.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerGetTrainingContext } from "../get_training_context.js";
import { registerGetActiveProgram } from "../get_active_program.js";
import { registerGetSessionDetails } from "../get_session_details.js";
import { registerGetBenchmarks } from "../get_benchmarks.js";
import { registerGetBodyAnalysis } from "../get_body_analysis.js";
import { registerSearchEngineResources } from "../search_engine_resources.js";
import { registerGetCoachInsight } from "../get_coach_insight.js";
import { registerGetOnboardingStatus } from "../get_onboarding_status.js";
import { registerResolveExerciseIds } from "../resolve_exercise_ids.js";
import { registerRunCalculator } from "../run_calculator.js";
import { registerScanBodyPhotos } from "../scan_body_photos.js";
import { registerGenerateProgram } from "../generate_program.js";
import { registerCompleteIntake } from "../complete_intake.js";
import { registerModifyTrainingSession } from "../modify_training_session.js";
import { registerLogWorkout } from "../log_workout.js";
import { registerSwapExercise } from "../swap_exercise.js";
import { registerUpdateUserProfile } from "../update_user_profile.js";
import { registerAddInjury } from "../add_injury.js";
import { registerLogCoachFeedback } from "../log_coach_feedback.js";
import { registerCreatePlannedSession } from "../create_planned_session.js";
import { registerDeleteSession } from "../delete_session.js";
import { registerLogCompletedSession } from "../log_completed_session.js";
import { registerUpdateSession } from "../update_session.js";
import { registerRecordBenchmark } from "../record_benchmark.js";
import { registerCheckIn } from "../check_in.js";
import { registerManageGoals } from "../manage_goals.js";
import { registerListGoals } from "../list_goals.js";
import { registerManageProgram } from "../manage_program.js";
import { registerGetProgramStatus } from "../get_program_status.js";
import { registerGetWeeklyDebrief } from "../get_weekly_debrief.js";

/** Every user tool as the directory lists it: name and description. */
function listedTools(): Map<string, string> {
  const tools = new Map<string, string>();
  const capture = (name: string, config: { description?: string } | string) => {
    tools.set(name, typeof config === "string" ? config : config?.description ?? "");
  };
  const server = { registerTool: capture, tool: capture } as never;
  for (const register of [
    registerGetTrainingContext, registerGetActiveProgram, registerGetSessionDetails, registerGetBenchmarks,
    registerGetBodyAnalysis, registerSearchEngineResources, registerGetCoachInsight, registerGetOnboardingStatus,
    registerResolveExerciseIds, registerRunCalculator, registerScanBodyPhotos, registerGenerateProgram,
    registerCompleteIntake, registerModifyTrainingSession, registerLogWorkout, registerSwapExercise,
    registerUpdateUserProfile, registerAddInjury, registerLogCoachFeedback, registerCreatePlannedSession,
    registerDeleteSession, registerLogCompletedSession, registerUpdateSession, registerRecordBenchmark,
    registerCheckIn, registerManageGoals, registerListGoals, registerManageProgram, registerGetProgramStatus,
    registerGetWeeklyDebrief,
  ]) register(server);
  return tools;
}

test("every listed tool has a description", () => {
  const tools = listedTools();
  assert.ok(tools.size >= 29, `found ${tools.size} tools`);
  for (const [name, description] of tools) assert.ok(description.length > 20, name);
});

test("no tool description names another tool", () => {
  const tools = listedTools();
  for (const [name, description] of tools) {
    for (const other of tools.keys()) {
      if (other === name) continue;
      assert.equal(new RegExp(`\\b${other}\\b`).test(description), false, `${name} names ${other}`);
    }
    // A tool the directory never lists is still another tool's name.
    assert.equal(/\bget_training_context\b/.test(description), false, `${name} names get_training_context`);
  }
});

test("no tool description tells the assistant how to behave", () => {
  for (const [name, description] of listedTools()) {
    for (const phrase of ["yourself", "in those words", "every time", "call again", "ask which", "you can ask"]) {
      assert.equal(description.toLowerCase().includes(phrase), false, `${name}: "${phrase}"`);
    }
  }
});
