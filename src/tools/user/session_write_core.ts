import { db, getActiveQueueDocuments, profileSubcollection } from "../../firestore-client.js";

export interface WriteExerciseInput {
  name: string;
  exerciseId?: string;
  sets?: number;
  reps?: number;
  weightKg?: number;
  durationSec?: number;
  durationMinutes?: number;
  distanceMeters?: number;
}

export interface UpdateSessionInput {
  sessionId: string;
  title?: string;
  sessionFocus?: string;
  durationMinutes?: number;
  status?: "planned" | "completed";
  scheduledDate?: string;
  rpe?: number;
  feedbackTags?: string[];
  feedbackNote?: string;
  exercises?: WriteExerciseInput[];
  coachNote?: string;
}

export interface ModifyTrainingSessionInput {
  sessionId: string;
  reduceVolume?: number;
  increaseIntensity?: number;
  swapExercise?: { from: string; to: string };
  rescheduleDate?: string;
}

export interface SessionWriteResult {
  sessionId: string;
  title?: string;
  status?: string;
  updatedFields?: string[];
  modifications?: string[];
  resolvedTargetType: "diary_session" | "queue_session";
  persistedRef: string;
  queueId?: string;
  message: string;
}

type ResolvedTarget = DiaryTarget | QueueTarget;

interface DiaryTarget {
  targetType: "diary_session";
  sessionId: string;
  sessionRef: FirebaseFirestore.DocumentReference;
  sessionData: Record<string, unknown>;
}

interface QueueTarget {
  targetType: "queue_session";
  sessionId: string;
  queueId: string;
  queueRef: FirebaseFirestore.DocumentReference;
  sessions: Array<Record<string, unknown>>;
  sessionIndex: number;
  sessionData: Record<string, unknown>;
}

interface ResolvedExercise extends WriteExerciseInput {
  exerciseId: string;
  identitySource: string;
  originalExerciseName: string;
}

export async function updateSessionCore(
  profileId: string,
  input: UpdateSessionInput,
): Promise<SessionWriteResult> {
  if (!hasUpdate(input)) {
    throw new Error("At least one field to update is required");
  }

  const target = await resolveSessionTarget(profileId, input.sessionId);
  const current = target.sessionData;
  assertWriteAllowed(input, isCompletedTarget(target), isImportedSession(current));

  const timestamp = new Date().toISOString();
  const resolvedExercises = input.exercises && input.exercises.length > 0 ?
    await resolveExercises(profileId, input.exercises, blocksOf(current), sessionType(current)) :
    undefined;

  if (target.targetType === "queue_session") {
    if (input.status != null) throw new Error("Queue sessions do not support direct status mutation");
    if (input.rpe != null || input.feedbackTags != null || input.feedbackNote != null) {
      throw new Error("Queue sessions do not support feedback fields");
    }
    const mutation = await commitQueueSessionMutation(target, timestamp, (freshTarget) =>
      mutateQueueSession(freshTarget, input, resolvedExercises, timestamp));
    return {
      sessionId: target.sessionId,
      title: String(input.sessionFocus ?? input.title ?? current.focus ?? ""),
      updatedFields: mutation.updatedFields,
      resolvedTargetType: target.targetType,
      persistedRef: targetRef(target),
      queueId: target.queueId,
      message: `Session updated: ${mutation.updatedFields.join(", ")}`,
    };
  }

  const updates: Record<string, unknown> = {
    updated_at: timestamp,
    mcp_updated_at: timestamp,
    session_write_updated_at: timestamp,
  };
  const updatedFields: string[] = [];

  if (input.title != null) {
    updates.title = input.title;
    updatedFields.push("title");
  }
  if (input.sessionFocus != null) {
    updates.session_focus = input.sessionFocus;
    updatedFields.push("sessionFocus");
  }
  if (input.durationMinutes != null) {
    updates.duration_minutes = input.durationMinutes;
    updatedFields.push("durationMinutes");
  }
  if (input.scheduledDate != null) {
    updates.scheduled_date = input.scheduledDate;
    updatedFields.push("scheduledDate");
  }
  if (input.status != null) {
    updates.status = input.status;
    updates.is_completed = input.status === "completed";
    if (input.status === "completed" && current.status !== "completed") {
      updates.completed_at = timestamp;
      if (!resolvedExercises || resolvedExercises.length === 0) {
        updates.blocks = copyTargetsToActuals(blocksOf(current));
      }
    }
    updatedFields.push("status");
  }
  if (input.rpe != null) {
    updates["feedback.rpe"] = input.rpe;
    updatedFields.push("rpe");
  }
  if (input.feedbackTags != null) {
    updates["feedback.tags"] = input.feedbackTags;
    updatedFields.push("feedbackTags");
  }
  if (input.feedbackNote != null) {
    updates["feedback.note"] = input.feedbackNote;
    updatedFields.push("feedbackNote");
  }
  if (input.coachNote != null) {
    updates.coach_note = {
      title: "Coach Note",
      message: input.coachNote,
      source: "session_write",
      created_at: timestamp,
    };
    updatedFields.push("coachNote");
  }
  if (resolvedExercises && resolvedExercises.length > 0) {
    updates.blocks = mergeExercisesIntoBlocks(blocksOf(current), resolvedExercises, sessionType(current));
    updatedFields.push("exercises");
  }

  await target.sessionRef.update(updates);
  return {
    sessionId: target.sessionId,
    title: String(input.title ?? current.title ?? ""),
    status: String(input.status ?? current.status ?? ""),
    updatedFields,
    resolvedTargetType: target.targetType,
    persistedRef: targetRef(target),
    message: `Session updated: ${updatedFields.join(", ")}`,
  };
}

export async function modifyTrainingSessionCore(
  profileId: string,
  input: ModifyTrainingSessionInput,
): Promise<SessionWriteResult> {
  if (!input.reduceVolume && !input.increaseIntensity && !input.swapExercise && !input.rescheduleDate) {
    throw new Error("At least one modification is required");
  }

  const target = await resolveSessionTarget(profileId, input.sessionId);
  const current = target.sessionData;
  assertWriteAllowed(
    toModificationGuardInput(input),
    isCompletedTarget(target),
    isImportedSession(current),
  );

  const timestamp = new Date().toISOString();
  const modifications: string[] = [];
  let blocks = cloneBlocks(blocksOf(current));
  let updatedBlocks = false;

  if (target.targetType === "queue_session") {
    const queueMutation = await commitQueueSessionMutation(target, timestamp, async (freshTarget) => {
      const freshCurrent = freshTarget.sessionData;
      const freshModifications: string[] = [];
      let freshBlocks = cloneBlocks(blocksOf(freshCurrent));
      let freshUpdatedBlocks = false;
      if (input.reduceVolume != null) {
        freshBlocks = scaleVolume(freshBlocks, input.reduceVolume);
        freshModifications.push(`Volume reduced by ${Math.round((1 - input.reduceVolume) * 100)}%`);
        freshUpdatedBlocks = true;
      }
      if (input.increaseIntensity != null) {
        freshBlocks = scaleIntensity(freshBlocks, input.increaseIntensity);
        const pctChange = Math.round((input.increaseIntensity - 1) * 100);
        freshModifications.push(`Intensity ${pctChange >= 0 ? "increased" : "decreased"} by ${Math.abs(pctChange)}%`);
        freshUpdatedBlocks = true;
      }
      if (input.swapExercise) {
        const [replacement] = await resolveExercises(profileId, [{ name: input.swapExercise.to }], freshBlocks, sessionType(freshCurrent));
        freshBlocks = swapExercise(freshBlocks, input.swapExercise.from, replacement);
        freshModifications.push(`Swapped "${input.swapExercise.from}" -> "${input.swapExercise.to}"`);
        freshUpdatedBlocks = true;
      }
      const sessions = freshTarget.sessions.map((session) => ({ ...session }));
      const queueSession = { ...sessions[freshTarget.sessionIndex] };
      if (freshUpdatedBlocks) queueSession.blocks = freshBlocks;
      if (input.rescheduleDate) {
        queueSession.scheduled_date = input.rescheduleDate;
        freshModifications.push(`Rescheduled to ${input.rescheduleDate}`);
      }
      queueSession.user_overridden = true;
      queueSession.override_reason = "Tool-driven session write";
      queueSession.last_user_edit_date = timestamp;
      queueSession.session_write_modified_at = timestamp;
      queueSession.adaptation_applied = true;
      sessions[freshTarget.sessionIndex] = queueSession;
      return {
        sessions,
        modifications: freshModifications,
        updatedFields: [
          ...(freshUpdatedBlocks ? ["blocks"] : []),
          ...(input.rescheduleDate ? ["scheduledDate"] : []),
        ],
      };
    });
    return {
      sessionId: target.sessionId,
      title: String(current.focus ?? ""),
      modifications: queueMutation.modifications,
      updatedFields: queueMutation.updatedFields,
      resolvedTargetType: target.targetType,
      persistedRef: targetRef(target),
      queueId: target.queueId,
      message: `Session modified successfully: ${queueMutation.modifications.join("; ")}`,
    };
  }

  if (input.reduceVolume != null) {
    blocks = scaleVolume(blocks, input.reduceVolume);
    modifications.push(`Volume reduced by ${Math.round((1 - input.reduceVolume) * 100)}%`);
    updatedBlocks = true;
  }
  if (input.increaseIntensity != null) {
    blocks = scaleIntensity(blocks, input.increaseIntensity);
    const pctChange = Math.round((input.increaseIntensity - 1) * 100);
    modifications.push(`Intensity ${pctChange >= 0 ? "increased" : "decreased"} by ${Math.abs(pctChange)}%`);
    updatedBlocks = true;
  }
  if (input.swapExercise) {
    const [replacement] = await resolveExercises(profileId, [{ name: input.swapExercise.to }], blocks, sessionType(current));
    blocks = swapExercise(blocks, input.swapExercise.from, replacement);
    modifications.push(`Swapped "${input.swapExercise.from}" -> "${input.swapExercise.to}"`);
    updatedBlocks = true;
  }

  const updates: Record<string, unknown> = {
    mcp_modified_at: timestamp,
    session_write_modified_at: timestamp,
    mcp_modifications: modifications,
    adaptation_applied: true,
    updated_at: timestamp,
  };
  if (updatedBlocks) updates.blocks = blocks;
  if (input.rescheduleDate) {
    updates.scheduled_date = input.rescheduleDate;
    modifications.push(`Rescheduled to ${input.rescheduleDate}`);
  }

  await target.sessionRef.update(updates);
  return {
    sessionId: target.sessionId,
    title: String(current.title ?? ""),
    modifications,
    updatedFields: Object.keys(updates).filter((key) => !key.startsWith("mcp_")),
    resolvedTargetType: target.targetType,
    persistedRef: targetRef(target),
    message: `Session modified successfully: ${modifications.join("; ")}`,
  };
}

async function resolveSessionTarget(profileId: string, sessionId: string): Promise<ResolvedTarget> {
  const diaryRef = profileSubcollection(profileId, "diary").doc(sessionId);
  const diarySnap = await diaryRef.get();
  if (diarySnap.exists) {
    return {
      targetType: "diary_session",
      sessionId,
      sessionRef: diaryRef,
      sessionData: (diarySnap.data() ?? {}) as Record<string, unknown>,
    };
  }

  const lookupIds = new Set([sessionId, normalizePlannedSessionLookupId(sessionId)]);
  const diaryCopy = await findDiarySessionForQueueLookup(profileId, lookupIds);
  if (diaryCopy) return diaryCopy;

  const { queueDocs } = await getActiveQueueDocuments(profileId);
  for (const queueDoc of queueDocs) {
    const data = (queueDoc.data() ?? {}) as Record<string, unknown>;
    const sessions = Array.isArray(data.sessions) ? data.sessions as Array<Record<string, unknown>> : [];
    const sessionIndex = sessions.findIndex((session) => lookupIds.has(String(session.id ?? "")));
    if (sessionIndex >= 0) {
      const resolvedSessionId = String(sessions[sessionIndex].id ?? sessionId);
      return {
        targetType: "queue_session",
        sessionId: resolvedSessionId,
        queueId: queueDoc.id,
        queueRef: queueDoc.ref,
        sessions,
        sessionIndex,
        sessionData: sessions[sessionIndex],
      };
    }
  }
  throw new Error(`Session "${sessionId}" not found`);
}

async function findDiarySessionForQueueLookup(
  profileId: string,
  lookupIds: Set<string>,
): Promise<DiaryTarget | null> {
  const ids = Array.from(lookupIds).filter((id) => id.trim()).slice(0, 10);
  if (ids.length === 0) return null;

  const snap = await profileSubcollection(profileId, "diary")
    .where("origin_queue_session_id", "in", ids)
    .get();
  const candidates = snap.docs
    .map((doc) => ({ doc, data: (doc.data() ?? {}) as Record<string, unknown> }))
    .filter(({ data }) => data.is_deleted !== true && data.deleted_at == null)
    .filter(({ data }) => String(data.status ?? "").toLowerCase() !== "skipped")
    .sort((a, b) => diaryTargetPriority(a.data) - diaryTargetPriority(b.data) ||
      comparableTimestamp(b.data) - comparableTimestamp(a.data));
  const winner = candidates[0];
  if (!winner) return null;
  return {
    targetType: "diary_session",
    sessionId: winner.doc.id,
    sessionRef: winner.doc.ref,
    sessionData: winner.data,
  };
}

async function commitQueueSessionMutation<T extends { sessions: Array<Record<string, unknown>> }>(
  target: QueueTarget,
  timestamp: string,
  buildMutation: (freshTarget: QueueTarget) => T | Promise<T>,
): Promise<T> {
  return db.runTransaction(async (tx) => {
    const queueSnap = await tx.get(target.queueRef);
    if (!queueSnap.exists) {
      throw new Error(`Queue "${target.queueId}" not found`);
    }
    const queueData = (queueSnap.data() ?? {}) as Record<string, unknown>;
    const sessions = Array.isArray(queueData.sessions) ?
      queueData.sessions as Array<Record<string, unknown>> :
      [];
    const sessionIndex = sessions.findIndex((session) => String(session.id ?? "") === target.sessionId);
    if (sessionIndex < 0) {
      throw new Error(`Session "${target.sessionId}" not found in queue "${target.queueId}"`);
    }
    const mutation = await buildMutation({
      ...target,
      sessions,
      sessionIndex,
      sessionData: sessions[sessionIndex],
    });
    tx.update(target.queueRef, {
      sessions: mutation.sessions,
      updated_at: timestamp,
    });
    return mutation;
  });
}

function mutateQueueSession(
  target: QueueTarget,
  input: UpdateSessionInput,
  exercises: ResolvedExercise[] | undefined,
  timestamp: string,
): { sessions: Array<Record<string, unknown>>; updatedFields: string[] } {
  const sessions = target.sessions.map((session) => ({ ...session }));
  const current = { ...sessions[target.sessionIndex] };
  const updatedFields: string[] = [];

  if (input.title != null || input.sessionFocus != null) {
    current.focus = input.sessionFocus ?? input.title;
    updatedFields.push("focus");
  }
  if (input.scheduledDate != null) {
    current.scheduled_date = input.scheduledDate;
    updatedFields.push("scheduledDate");
  }
  if (input.durationMinutes != null) {
    current.duration_minutes = input.durationMinutes;
    updatedFields.push("durationMinutes");
  }
  if (input.coachNote != null) {
    current.coach_note = {
      title: "Coach Note",
      message: input.coachNote,
      source: "session_write",
      created_at: timestamp,
    };
    updatedFields.push("coachNote");
  }
  if (exercises && exercises.length > 0) {
    current.blocks = mergeExercisesIntoBlocks(blocksOf(current), exercises, sessionType(current));
    updatedFields.push("exercises");
  }
  if (updatedFields.length === 0) throw new Error("No queue-session fields provided to update");

  current.user_overridden = true;
  current.override_reason = "Tool-driven manual session update";
  current.last_user_edit_date = timestamp;
  current.session_write_modified_at = timestamp;
  current.adaptation_applied = true;
  sessions[target.sessionIndex] = current;
  return { sessions, updatedFields };
}

async function resolveExercises(
  profileId: string,
  exercises: WriteExerciseInput[],
  targetBlocks: Array<Record<string, unknown>>,
  modality: string,
): Promise<ResolvedExercise[]> {
  const targetIndex = indexTargetExercises(targetBlocks);
  const profileIndex = await loadProfileExerciseIndex(profileId);
  return exercises.map((exercise) => {
    const normalized = normalizeName(exercise.name);
    const explicitId = exercise.exerciseId?.trim();
    if (explicitId) {
      const trusted = trustedExplicitRecord(explicitId, exercise.name, targetIndex, profileIndex);
      if (trusted) {
        return {
          ...exercise,
          name: trusted.name,
          exerciseId: trusted.id,
          identitySource: "explicit_id",
          originalExerciseName: exercise.name,
        };
      }
    }
    const targetRecord = targetIndex.byName.get(normalized);
    if (targetRecord) {
      return {
        ...exercise,
        exerciseId: targetRecord.id,
        identitySource: "target_session_name_match",
        originalExerciseName: exercise.name,
      };
    }
    const profileRecord = profileIndex.byName.get(normalized);
    if (profileRecord) {
      return {
        ...exercise,
        name: profileRecord.name,
        exerciseId: profileRecord.id,
        identitySource: "profile_exercise_record_name_match",
        originalExerciseName: exercise.name,
      };
    }
    return {
      ...exercise,
      exerciseId: deterministicExerciseId(`${modality}_${exercise.name}`),
      identitySource: "deterministic_fallback",
      originalExerciseName: exercise.name,
    };
  });
}

function mergeExercisesIntoBlocks(
  existingBlocks: Array<Record<string, unknown>>,
  exercises: ResolvedExercise[],
  modality: string,
): Array<Record<string, unknown>> {
  const blocks = cloneBlocks(existingBlocks);
  if (blocks.length === 0) {
    return [{
      id: shortId("block_main"),
      type: "single",
      rounds: 1,
      semantic_type: "main",
      exercises: exercises.map((exercise) => buildExercise(exercise, modality)),
    }];
  }

  for (const exercise of exercises) {
    const match = findExercise(blocks, exercise);
    if (match) {
      const blockExercises = (blocks[match.blockIndex].exercises as Array<Record<string, unknown>>) ?? [];
      blockExercises[match.exerciseIndex] = buildExercise(exercise, modality, blockExercises[match.exerciseIndex]);
      blocks[match.blockIndex].exercises = blockExercises;
    } else {
      const block = blocks.find((candidate) => candidate.semantic_type === "main") ?? blocks[blocks.length - 1];
      const blockExercises = (block.exercises as Array<Record<string, unknown>>) ?? [];
      blockExercises.push(buildExercise(exercise, modality));
      block.exercises = blockExercises;
    }
  }
  return blocks;
}

function buildExercise(
  exercise: ResolvedExercise,
  modality: string,
  existing?: Record<string, unknown>,
): Record<string, unknown> {
  const existingSets = (existing?.sets as Array<Record<string, unknown>> | undefined) ?? [];
  return {
    ...(existing ?? {}),
    exercise_id: exercise.exerciseId,
    exercise_name: exercise.name,
    exercise_identity_source: exercise.identitySource,
    resolved_exercise_id: exercise.exerciseId,
    original_exercise_name: exercise.originalExerciseName,
    sets: buildSets(exercise, modality, existingSets),
  };
}

function buildSets(
  exercise: WriteExerciseInput,
  modality: string,
  existingSets: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const count = Math.max(1, Math.round(exercise.sets ?? (existingSets.length || 1)));
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i++) {
    out.push(stripNullModalityFields({
      ...(existingSets[i] ?? {}),
      ...rawSetForExercise(exercise, modality),
      id: (existingSets[i]?.id as string | undefined) ?? shortId("set"),
    }));
  }
  return out;
}

function rawSetForExercise(exercise: WriteExerciseInput, modality: string): Record<string, unknown> {
  const isStrength = exercise.weightKg != null || exercise.reps != null || modality === "strength";
  const isCardio = exercise.distanceMeters != null || exercise.durationSec != null || exercise.durationMinutes != null;
  if (isStrength && !isCardio) {
    return {
      type: "strength",
      ...(exercise.weightKg != null ? { target_weight_kg: exercise.weightKg } : {}),
      ...(exercise.reps != null ? { target_reps: exercise.reps } : {}),
    };
  }
  if (isCardio) {
    const durationSec = exercise.durationSec ?? (
      exercise.durationMinutes != null ? Math.round(exercise.durationMinutes * 60) : undefined
    );
    return {
      type: "cardio",
      ...(exercise.distanceMeters != null ? { target_distance_meters: exercise.distanceMeters } : {}),
      ...(durationSec != null ? { target_duration_sec: durationSec } : {}),
    };
  }
  return { type: "general" };
}

function scaleVolume(blocks: Array<Record<string, unknown>>, multiplier: number): Array<Record<string, unknown>> {
  return blocks.map((block) => ({
    ...block,
    exercises: ((block.exercises as Array<Record<string, unknown>>) ?? []).map((exercise) => {
      const sets = (exercise.sets as Array<Record<string, unknown>>) ?? [];
      const targetSetCount = Math.max(1, Math.round(sets.length * multiplier));
      return {
        ...exercise,
        sets: sets.slice(0, targetSetCount).map((set) => ({
          ...set,
          ...(typeof set.target_reps === "number" ?
            { target_reps: Math.max(1, Math.round(set.target_reps * multiplier)) } :
            {}),
        })),
      };
    }),
  }));
}

function scaleIntensity(blocks: Array<Record<string, unknown>>, multiplier: number): Array<Record<string, unknown>> {
  return blocks.map((block) => ({
    ...block,
    exercises: ((block.exercises as Array<Record<string, unknown>>) ?? []).map((exercise) => ({
      ...exercise,
      sets: ((exercise.sets as Array<Record<string, unknown>>) ?? []).map((set) => ({
        ...set,
        ...(typeof set.target_weight_kg === "number" ?
          { target_weight_kg: round1(set.target_weight_kg * multiplier) } :
          {}),
        ...(typeof set.target_rpe === "number" ?
          { target_rpe: Math.min(10, round1(set.target_rpe * multiplier)) } :
          {}),
      })),
    })),
  }));
}

function swapExercise(
  blocks: Array<Record<string, unknown>>,
  fromExercise: string,
  replacement: ResolvedExercise,
): Array<Record<string, unknown>> {
  const from = normalizeName(fromExercise);
  let swapped = 0;
  const next = blocks.map((block) => ({
    ...block,
    exercises: ((block.exercises as Array<Record<string, unknown>>) ?? []).map((exercise) => {
      if (normalizeName(String(exercise.exercise_name ?? "")) !== from) return exercise;
      swapped++;
      return {
        ...exercise,
        exercise_id: replacement.exerciseId,
        exercise_name: replacement.name,
        original_exercise_id: exercise.original_exercise_id ?? exercise.exercise_id,
        original_exercise_name: exercise.original_exercise_name ?? exercise.exercise_name,
        exercise_identity_source: replacement.identitySource,
        resolved_exercise_id: replacement.exerciseId,
        mcp_swap_note: `Swapped from "${fromExercise}"`,
      };
    }),
  }));
  if (swapped === 0) throw new Error(`Exercise "${fromExercise}" not found in session`);
  return next;
}

function copyTargetsToActuals(blocks: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return cloneBlocks(blocks).map((block) => ({
    ...block,
    exercises: ((block.exercises as Array<Record<string, unknown>>) ?? []).map((exercise) => ({
      ...exercise,
      sets: ((exercise.sets as Array<Record<string, unknown>>) ?? []).map((set) => stripNullModalityFields({
        ...set,
        isCompleted: true,
        ...(set.target_weight_kg != null ? { actual_weight_kg: set.target_weight_kg } : {}),
        ...(set.target_reps != null ? { actual_reps: set.target_reps } : {}),
        ...(set.target_distance_meters != null ? { actual_distance_meters: set.target_distance_meters } : {}),
        ...(set.target_duration_sec != null ? { actual_duration_sec: set.target_duration_sec } : {}),
      })),
    })),
  }));
}

function assertWriteAllowed(
  input: UpdateSessionInput,
  isCompleted: boolean,
  isImported: boolean,
): void {
  if (!isCompleted && !isImported) return;
  const unsafeFields = [
    input.title != null ? "title" : null,
    input.sessionFocus != null ? "sessionFocus" : null,
    input.durationMinutes != null ? "durationMinutes" : null,
    input.scheduledDate != null ? "scheduledDate" : null,
    input.exercises && input.exercises.length > 0 ? "exercises" : null,
    input.status != null && input.status !== "completed" ? "status" : null,
  ].filter((field): field is string => field != null);
  if (unsafeFields.length === 0) return;
  throw new Error(isCompleted ?
    `Cannot change ${unsafeFields.join(", ")} on a completed session` :
    `Cannot change ${unsafeFields.join(", ")} on an imported session`);
}

function toModificationGuardInput(input: ModifyTrainingSessionInput): UpdateSessionInput {
  return {
    sessionId: input.sessionId,
    scheduledDate: input.rescheduleDate,
    exercises: input.reduceVolume != null || input.increaseIntensity != null || input.swapExercise ?
      [{ name: input.swapExercise?.to ?? "session structure" }] :
      undefined,
  };
}

function hasUpdate(input: UpdateSessionInput): boolean {
  return input.title != null ||
    input.sessionFocus != null ||
    input.durationMinutes != null ||
    input.status != null ||
    input.scheduledDate != null ||
    input.rpe != null ||
    input.feedbackTags != null ||
    input.feedbackNote != null ||
    input.exercises != null ||
    input.coachNote != null;
}

function isCompletedTarget(target: ResolvedTarget): boolean {
  return target.sessionData.is_completed === true ||
    target.sessionData.isCompleted === true ||
    target.sessionData.status === "completed";
}

function isImportedSession(session: Record<string, unknown>): boolean {
  const completedVia = String(session.completed_via ?? session.completedVia ?? "").toLowerCase();
  const source = String(session.source ?? "").toLowerCase();
  const dataQuality = String(session.data_quality ?? session.dataQuality ?? "").toLowerCase();
  return session.strava_activity_id != null ||
    session.external_activity_id != null ||
    completedVia === "strava" ||
    source === "strava" ||
    dataQuality === "imported";
}

function blocksOf(session: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(session.blocks) ? session.blocks as Array<Record<string, unknown>> : [];
}

function sessionType(session: Record<string, unknown>): string {
  return String(session.session_type ?? session.slot_type ?? "strength");
}

function targetRef(target: ResolvedTarget): string {
  return target.targetType === "diary_session" ?
    target.sessionRef.path :
    `${target.queueRef.path}/sessions/${target.sessionId}`;
}

function diaryTargetPriority(data: Record<string, unknown>): number {
  const status = String(data.status ?? "").toLowerCase();
  if (status === "in_progress" || data.started_at != null) return 0;
  if (data.is_completed !== true && status !== "completed") return 1;
  return 2;
}

function comparableTimestamp(data: Record<string, unknown>): number {
  const value = data.updated_at ?? data.started_at ?? data.created_at;
  if (typeof value === "string") return Date.parse(value) || 0;
  if (value && typeof value === "object" && "toDate" in value &&
      typeof (value as { toDate: () => Date }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().getTime();
  }
  return 0;
}

function normalizePlannedSessionLookupId(sessionId: string): string {
  return sessionId.startsWith("plan_") ? sessionId.slice("plan_".length) : sessionId;
}

type ExerciseIndex = {
  byName: Map<string, { id: string; name: string }>;
  byId: Map<string, { id: string; name: string }>;
};

function indexTargetExercises(blocks: Array<Record<string, unknown>>): ExerciseIndex {
  const out: ExerciseIndex = { byName: new Map(), byId: new Map() };
  for (const block of blocks) {
    for (const exercise of ((block.exercises ?? []) as Array<Record<string, unknown>>)) {
      const name = String(exercise.exercise_name ?? "");
      const id = String(exercise.exercise_id ?? "");
      if (!name || !id) continue;
      const record = { id, name };
      if (!out.byName.has(normalizeName(name))) out.byName.set(normalizeName(name), record);
      if (!out.byId.has(id)) out.byId.set(id, record);
    }
  }
  return out;
}

async function loadProfileExerciseIndex(profileId: string): Promise<ExerciseIndex> {
  const out: ExerciseIndex = { byName: new Map(), byId: new Map() };
  const snap = await profileSubcollection(profileId, "exercise_records").limit(500).get();
  for (const doc of snap.docs) {
    const data = (doc.data() ?? {}) as Record<string, unknown>;
    const name = String(data.exerciseName ?? data.exercise_name ?? "").trim();
    const id = String(data.exerciseId ?? data.exercise_id ?? doc.id).trim();
    if (!name || !id) continue;
    const record = { id, name };
    if (!out.byName.has(normalizeName(name))) out.byName.set(normalizeName(name), record);
    if (!out.byId.has(id)) out.byId.set(id, record);
  }
  return out;
}

function trustedExplicitRecord(
  exerciseId: string,
  exerciseName: string,
  targetIndex: ExerciseIndex,
  profileIndex: ExerciseIndex,
): { id: string; name: string } | null {
  const normalized = normalizeName(exerciseName);
  const target = targetIndex.byId.get(exerciseId);
  if (target && normalizeName(target.name) === normalized) return target;
  const profile = profileIndex.byId.get(exerciseId);
  if (profile && normalizeName(profile.name) === normalized) return profile;
  return null;
}

function findExercise(
  blocks: Array<Record<string, unknown>>,
  exercise: ResolvedExercise,
): { blockIndex: number; exerciseIndex: number } | null {
  const wantedName = normalizeName(exercise.name);
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const exercises = (blocks[blockIndex].exercises as Array<Record<string, unknown>>) ?? [];
    for (let exerciseIndex = 0; exerciseIndex < exercises.length; exerciseIndex++) {
      const candidate = exercises[exerciseIndex];
      if (String(candidate.exercise_id ?? "") === exercise.exerciseId) return { blockIndex, exerciseIndex };
      if (normalizeName(String(candidate.exercise_name ?? "")) === wantedName) return { blockIndex, exerciseIndex };
    }
  }
  return null;
}

function cloneBlocks(blocks: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return blocks.map((block) => ({
    ...block,
    exercises: ((block.exercises as Array<Record<string, unknown>>) ?? []).map((exercise) => ({
      ...exercise,
      sets: ((exercise.sets as Array<Record<string, unknown>>) ?? [])
        .map((set) => stripNullModalityFields(set)),
    })),
  }));
}

function stripNullModalityFields(set: Record<string, unknown>): Record<string, unknown> {
  const out = { ...set };
  for (const key of [
    "target_weight_kg",
    "target_reps",
    "actual_weight_kg",
    "actual_reps",
    "target_distance_meters",
    "target_duration_sec",
    "actual_distance_meters",
    "actual_duration_sec",
  ]) {
    if (out[key] == null) delete out[key];
  }
  return out;
}

function deterministicExerciseId(value: string): string {
  return `ai_ex_${normalizeName(value).replace(/\s+/g, "_").slice(0, 80) || "exercise"}`;
}

function shortId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
