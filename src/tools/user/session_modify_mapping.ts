/**
 * session_modify_mapping.ts: pure input builders for the update_session and
 * modify_training_session wrappers (WS1.1/WS1.3, exercise naming plan
 * 02/07/2026). Maps the legacy tool params onto the core `modify_session`
 * and `log_session` contracts spoken over the coreToolsBridge.
 *
 * Same boundary as core_adapter.ts: this module maps shapes only. Ownership,
 * scope, rate-limit, and scrubbing stay in the calling tool wrappers; nothing
 * in this file reads auth, Firestore, or the network.
 */

import {
  type CoreWriteBlockSpec,
  type LegacyLoggedExerciseFields,
  mapLegacyLoggedExercise,
} from "../shared/core_adapter.js";

// ─────────────────────────────────────────────────────────────────────────────
// update_session
// ─────────────────────────────────────────────────────────────────────────────

/** The update_session tool params after zod validation. */
export interface UpdateSessionParams {
  sessionId: string;
  title?: string;
  sessionFocus?: string;
  durationMinutes?: number;
  status?: "planned" | "completed";
  scheduledDate?: string;
  rpe?: number;
  feedbackTags?: string[];
  feedbackNote?: string;
  exercises?: LegacyLoggedExerciseFields[];
  blocks?: CoreWriteBlockSpec[];
  coachNote?: string;
}

/** Names of the fields a call actually provided, in the legacy reporting
 *  order, so "at least one field" validation and the updatedFields echo keep
 *  their historical shape. */
export function listProvidedUpdateFields(params: UpdateSessionParams): string[] {
  const fields: Array<[string, unknown]> = [
    ["title", params.title],
    ["sessionFocus", params.sessionFocus],
    ["durationMinutes", params.durationMinutes],
    ["status", params.status],
    ["scheduledDate", params.scheduledDate],
    ["rpe", params.rpe],
    ["feedbackTags", params.feedbackTags],
    ["feedbackNote", params.feedbackNote],
    ["exercises", params.exercises],
    ["blocks", params.blocks],
    ["coachNote", params.coachNote],
  ];
  return fields.filter(([, value]) => value != null).map(([name]) => name);
}

/** True when the call asks for the planned -> completed transition. That
 *  routes to core log_session (the completion path: target -> actual copy,
 *  actual-set writes) instead of a bare metadata status flip, preserving the
 *  legacy W2 behaviour. */
export function isCompletionRequest(params: UpdateSessionParams): boolean {
  return params.status === "completed";
}

/** Build the core modify_session type='metadata' input for a non-completion
 *  update. Every legacy field is mapped explicitly (the server silently
 *  ignores unknown keys, so an unmapped field would be dropped without an
 *  error). */
export function buildUpdateSessionMetadataInput(
  params: UpdateSessionParams,
): Record<string, unknown> {
  const input: Record<string, unknown> = { type: "metadata", sessionId: params.sessionId };
  if (params.title != null) input.title = params.title;
  if (params.sessionFocus != null) input.sessionFocus = params.sessionFocus;
  if (params.durationMinutes != null) input.durationMinutes = params.durationMinutes;
  if (params.status != null) input.status = params.status;
  if (params.scheduledDate != null) input.scheduledDate = params.scheduledDate;
  if (params.rpe != null) input.rpe = params.rpe;
  if (params.feedbackTags != null) input.feedbackTags = params.feedbackTags;
  if (params.feedbackNote != null) input.feedbackNote = params.feedbackNote;
  if (params.coachNote != null) input.coachNote = params.coachNote;
  if (params.exercises && params.exercises.length > 0) {
    input.exercises = params.exercises.map(mapLegacyLoggedExercise);
    // Legacy update_session semantics: provided exercises REPLACE the session
    // structure (the schema has always said "Overwrites existing blocks"), so
    // the core patch-first default is overridden explicitly.
    input.replaceExercises = true;
  }
  if (params.blocks && params.blocks.length > 0) input.blocks = params.blocks;
  return input;
}

/** Build the core log_session input for a status='completed' update. Without
 *  exercises, completedAsPrescribed copies target -> actual on the existing
 *  blocks (legacy W2 parity); with exercises, the provided work is written as
 *  actual sets, resolved through the write-time identity ladder. */
export function buildUpdateSessionCompletionInput(
  params: UpdateSessionParams,
): Record<string, unknown> {
  const exercises = params.exercises && params.exercises.length > 0 ?
    params.exercises.map(mapLegacyLoggedExercise) :
    undefined;
  const input: Record<string, unknown> = {
    plannedSessionId: params.sessionId,
    // sport is required by the log_session contract but is never persisted on
    // the complete-existing-target path (the session keeps its own
    // session_type); "general" is a neutral placeholder, not a decision.
    sport: "general",
    completedAsPrescribed: exercises == null,
  };
  if (exercises) input.exercises = exercises;
  if (params.title != null) input.title = params.title;
  if (params.sessionFocus != null) input.sessionFocus = params.sessionFocus;
  if (params.durationMinutes != null) input.durationMinutes = params.durationMinutes;
  if (params.rpe != null) input.rpe = params.rpe;
  if (params.feedbackTags != null) input.feedbackTags = params.feedbackTags;
  if (params.feedbackNote != null) input.feedbackNote = params.feedbackNote;
  if (params.coachNote != null) input.coachNote = params.coachNote;
  return input;
}

// ─────────────────────────────────────────────────────────────────────────────
// modify_training_session
// ─────────────────────────────────────────────────────────────────────────────

/** The modify_training_session tool params after zod validation. */
export interface ModifyTrainingSessionParams {
  sessionId: string;
  reduceVolume?: number;
  increaseIntensity?: number;
  swapExercise?: { from: string; to: string; toExerciseId?: string };
  rescheduleDate?: string;
}

export interface ModifySessionOperation {
  /** Reads as "Error <action>: ..." in the bridge failure mapping. */
  action: string;
  /** A core modify_session discriminated-union input. */
  input: Record<string, unknown>;
}

/** Map the legacy combined-modification params onto core modify_session's
 *  discriminated operations. Order matches the legacy apply order (volume +
 *  intensity, then swap, then reschedule) so combined calls modify the
 *  session the same way they always did; volume and intensity collapse into
 *  ONE core scale operation. Multipliers pass through unchanged (both
 *  dialects speak multipliers; no unit conversion). */
export function buildModifyTrainingOperations(
  params: ModifyTrainingSessionParams,
): ModifySessionOperation[] {
  const operations: ModifySessionOperation[] = [];
  if (params.reduceVolume != null || params.increaseIntensity != null) {
    const input: Record<string, unknown> = { type: "scale", sessionId: params.sessionId };
    if (params.reduceVolume != null) input.volumeMultiplier = params.reduceVolume;
    if (params.increaseIntensity != null) input.intensityMultiplier = params.increaseIntensity;
    operations.push({ action: "scaling session", input });
  }
  if (params.swapExercise) {
    const input: Record<string, unknown> = {
      type: "swap",
      sessionId: params.sessionId,
      fromExercise: params.swapExercise.from,
      toExercise: params.swapExercise.to,
    };
    if (params.swapExercise.toExerciseId != null) {
      input.toExerciseId = params.swapExercise.toExerciseId;
    }
    operations.push({
      action: `swapping "${params.swapExercise.from}" for "${params.swapExercise.to}"`,
      input,
    });
  }
  if (params.rescheduleDate != null) {
    operations.push({
      action: "rescheduling session",
      input: { type: "reschedule", sessionId: params.sessionId, newDate: params.rescheduleDate },
    });
  }
  return operations;
}
