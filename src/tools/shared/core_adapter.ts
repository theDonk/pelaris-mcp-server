/**
 * core_adapter.ts: shared shape-mapping between the legacy MCP write-tool
 * schemas and the core write contracts spoken over the coreToolsBridge
 * (see bridge_client.ts).
 *
 * BOUNDARY: this adapter only maps shapes. Ownership, scope, rate-limit,
 * and scrubbing stay in each calling tool wrapper, never here; nothing in
 * this file reads auth, Firestore, or the network.
 *
 * WHY EXPLICIT MAPPING: the server applies write inputs by field name and
 * silently ignores unknown keys. A legacy field forwarded under the wrong
 * name (`weight` instead of `weightKg`) or wrong unit (`duration` seconds
 * instead of `durationMinutes`) is dropped without an error and the tool
 * still reports success. Every legacy field and unit conversion is therefore
 * mapped explicitly here, once, and unit-tested.
 */

import { z } from "zod";
import type { BridgeResult } from "./bridge_client.js";

// ─────────────────────────────────────────────────────────────────────────────
// Teaching description constants (shared across the write-tool schemas)
// ─────────────────────────────────────────────────────────────────────────────

export const EXERCISE_NAME_DESCRIPTION =
  "Exercise name, the movement only, e.g. 'Barbell Bench Press'. Never encode grouping or " +
  "ordering (e.g. 'Superset 1A', 'SS 1B') in the name; group supersets with blocks[].structure instead.";

export const EXERCISE_ID_DESCRIPTION =
  "Canonical exercise ID from a read tool (e.g. get_session_details, get_exercise_history) or " +
  "resolve_exercise_ids. Provide it when known so history, 'Last' values, and PR detection attach " +
  "to the right movement. Verified before persistence.";

export const STRUCTURE_DESCRIPTION =
  "Block shape: 'single' (one exercise), 'superset' (exercises alternated back to back), " +
  "'circuit' (exercises in rotation). Always set this explicitly; supersets are expressed here, " +
  "never in exercise names.";

export const BLOCKS_DESCRIPTION =
  "Structured blocks with phase grouping and structure (single/superset/circuit). Preferred over " +
  "flat exercises[] for any session with phases (warm-up + main + cool-down) or grouped work " +
  "(supersets, circuits). If both blocks[] and exercises[] are provided, blocks[] wins.";

// ─────────────────────────────────────────────────────────────────────────────
// Shared zod fragments mirroring the core write contract
// (field names must match the server contract exactly; see header)
// ─────────────────────────────────────────────────────────────────────────────

export const exerciseIdField = z
  .string()
  .min(1)
  .max(120)
  .optional()
  .describe(EXERCISE_ID_DESCRIPTION);

export const coreWriteExerciseSchema = z.object({
  name: z.string().min(1).max(200).describe(EXERCISE_NAME_DESCRIPTION),
  exerciseId: exerciseIdField,
  sets: z.number().int().min(1).max(50).optional().describe("Number of sets"),
  reps: z
    .union([z.number().int().min(1).max(200), z.string().min(1).max(40)])
    .optional()
    .describe("Reps per set: a number, or a short string like '8-10' or 'AMRAP'"),
  weightKg: z.number().min(0).max(1000).optional().describe("Weight in kg"),
  durationMinutes: z
    .number()
    .min(0)
    .max(600)
    .optional()
    .describe("Duration in MINUTES (cardio/timed exercises). Minutes, not seconds: 90 seconds is 1.5."),
  distanceMeters: z.number().min(0).max(100000).optional().describe("Distance in meters (swim/run/ride)"),
  restSeconds: z.number().int().min(0).max(3600).optional().describe("Rest between sets in seconds. 0 = no rest."),
  rpe: z.number().min(1).max(10).optional().describe("Target RPE, 1-10"),
  pace: z
    .string()
    .max(80)
    .optional()
    .describe("Cardio pace target: 'CSS pace', 'easy Z2', 'tempo', 'all out', etc."),
  zone: z.number().int().min(1).max(5).optional().describe("Cardio training zone 1-5"),
  strokeType: z
    .string()
    .max(40)
    .optional()
    .describe("Swim only: 'freestyle', 'backstroke', 'breaststroke', 'butterfly', 'drill', 'kick', 'choice'"),
  cue: z
    .string()
    .max(80)
    .optional()
    .describe("Movement-specific coach cue, max 80 chars. Action-first phrasing: 'Drive through front heel, ribs down'."),
  notes: z.string().max(500).optional().describe("Exercise-specific notes"),
});

export const coreWriteBlockSchema = z.object({
  semanticType: z
    .enum(["warm_up", "main", "cool_down", "drill", "accessory"])
    .describe("Phase tag, drives section grouping in the app (Warmup / Main / Cooldown)"),
  structure: z.enum(["single", "superset", "circuit"]).optional().describe(STRUCTURE_DESCRIPTION),
  rounds: z.number().int().min(1).max(50).optional().describe("Rounds for superset/circuit blocks. Defaults to 1."),
  drillInstruction: z
    .string()
    .max(300)
    .optional()
    .describe("Block-level coaching instruction (e.g. 'Catch focus throughout')"),
  effortLevel: z
    .string()
    .max(50)
    .optional()
    .describe("Swim-specific effort tag: 'easy', 'moderate', 'threshold', 'sprint', 'technique', 'race_pace'"),
  equipment: z
    .array(z.string().max(80))
    .max(10)
    .optional()
    .describe("Equipment annotations for the block (swim: 'pull buoy', 'fins', 'kickboard')"),
  exercises: z.array(coreWriteExerciseSchema).min(1).max(30).describe("Exercises within the block (max 30)"),
});

/** Ready-to-register optional blocks[] field for the write-tool schemas.
 *  An empty array is accepted and treated as absent by resolveBlocksInput,
 *  so agents sending blocks: [] alongside flat exercises[] still succeed. */
export const coreWriteBlocksField = z
  .array(coreWriteBlockSchema)
  .max(20)
  .optional()
  .describe(BLOCKS_DESCRIPTION);

/** Core-shaped exercise spec, exactly the field names the server persists. */
export type CoreWriteExerciseSpec = z.infer<typeof coreWriteExerciseSchema>;

/** Core-shaped block spec (structure single|superset|circuit, rounds, exercises[]). */
export type CoreWriteBlockSpec = z.infer<typeof coreWriteBlockSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Legacy field dialects (per write-tool family) + unit conversions
// ─────────────────────────────────────────────────────────────────────────────

/** Legacy exercise dialect of create_planned_session:
 *  weight (kg), duration (SECONDS), distance (meters). */
export interface LegacyPlannedExerciseFields {
  name: string;
  exerciseId?: string;
  sets?: number;
  reps?: number;
  /** Target weight in kg. */
  weight?: number;
  /** Duration in SECONDS (legacy schema unit; core wants minutes). */
  duration?: number;
  /** Distance in meters. */
  distance?: number;
  notes?: string;
}

/** Legacy exercise dialect of log_workout, log_completed_session, and
 *  update_session: weightKg, durationSec (SECONDS), distanceMeters. */
export interface LegacyLoggedExerciseFields {
  name: string;
  exerciseId?: string;
  sets?: number;
  reps?: number;
  weightKg?: number;
  /** Duration in SECONDS (legacy schema unit; core wants minutes). */
  durationSec?: number;
  distanceMeters?: number;
  notes?: string;
}

/** Legacy schemas speak seconds; the core contract speaks minutes. Fractional
 *  minutes are preserved (90s -> 1.5); the server converts back to whole
 *  seconds at persist time. */
export function secondsToDurationMinutes(seconds: number): number {
  return seconds / 60;
}

/** Map one create_planned_session legacy exercise to the core spec.
 *  weight -> weightKg, duration (seconds) -> durationMinutes,
 *  distance -> distanceMeters. Zero values are preserved. */
export function mapLegacyPlannedExercise(ex: LegacyPlannedExerciseFields): CoreWriteExerciseSpec {
  const spec: CoreWriteExerciseSpec = { name: ex.name };
  if (ex.exerciseId !== undefined) spec.exerciseId = ex.exerciseId;
  if (ex.sets !== undefined) spec.sets = ex.sets;
  if (ex.reps !== undefined) spec.reps = ex.reps;
  if (ex.weight !== undefined) spec.weightKg = ex.weight;
  if (ex.duration !== undefined) spec.durationMinutes = secondsToDurationMinutes(ex.duration);
  if (ex.distance !== undefined) spec.distanceMeters = ex.distance;
  if (ex.notes !== undefined) spec.notes = ex.notes;
  return spec;
}

/** Map one log_workout / log_completed_session / update_session legacy
 *  exercise to the core spec. durationSec (seconds) -> durationMinutes;
 *  weightKg and distanceMeters already match. Zero values are preserved. */
export function mapLegacyLoggedExercise(ex: LegacyLoggedExerciseFields): CoreWriteExerciseSpec {
  const spec: CoreWriteExerciseSpec = { name: ex.name };
  if (ex.exerciseId !== undefined) spec.exerciseId = ex.exerciseId;
  if (ex.sets !== undefined) spec.sets = ex.sets;
  if (ex.reps !== undefined) spec.reps = ex.reps;
  if (ex.weightKg !== undefined) spec.weightKg = ex.weightKg;
  if (ex.durationSec !== undefined) spec.durationMinutes = secondsToDurationMinutes(ex.durationSec);
  if (ex.distanceMeters !== undefined) spec.distanceMeters = ex.distanceMeters;
  if (ex.notes !== undefined) spec.notes = ex.notes;
  return spec;
}

// ─────────────────────────────────────────────────────────────────────────────
// Flat-to-blocks mapping
// ─────────────────────────────────────────────────────────────────────────────

/** Wrap flat exercises[] into ONE explicit single-structure block per
 *  exercise, so a plain flat create can never be inferred into a superset or
 *  circuit downstream. Grouping is only ever expressed via explicit blocks[]. */
export function flatExercisesToBlocks(exercises: CoreWriteExerciseSpec[]): CoreWriteBlockSpec[] {
  return exercises.map((exercise) => ({
    semanticType: "main" as const,
    structure: "single" as const,
    exercises: [exercise],
  }));
}

/** Pick the blocks payload for a bridge call: explicit blocks[] pass through
 *  untouched (blocks win over flat, matching the core contract); flat
 *  exercises (already mapped to core specs) become per-exercise single
 *  blocks; neither -> undefined (omit the field). */
export function resolveBlocksInput(
  blocks: CoreWriteBlockSpec[] | undefined,
  flatExercises: CoreWriteExerciseSpec[] | undefined,
): CoreWriteBlockSpec[] | undefined {
  if (blocks && blocks.length > 0) return blocks;
  if (flatExercises && flatExercises.length > 0) return flatExercisesToBlocks(flatExercises);
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bridge envelope -> MCP tool response
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Standard MCP error response shape (mirrors ownershipErrorResponse).
 * Type alias on purpose: the MCP SDK's CallToolResult requires an index
 * signature, and only object type aliases receive TypeScript's implicit
 * index signature (interfaces do not).
 */
export type McpErrorResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
};

/**
 * Map a failed bridge envelope to the standard MCP error response, or null
 * when the envelope is a success. `errorDetail` (e.g. preflight candidate
 * ids on a needs_disambiguation error) is appended as compact JSON so the
 * calling agent can self-correct and retry.
 *
 * `action` reads as "Error <action>: ...", e.g. "creating planned session".
 */
export function bridgeFailureResponse(bridged: BridgeResult, action: string): McpErrorResponse | null {
  if (bridged.ok && bridged.result != null) return null;
  const message = `Error ${action}: ${bridged.error ?? "unknown error"}`;
  const text = bridged.errorDetail != null
    ? `${message}\n${JSON.stringify(bridged.errorDetail)}`
    : message;
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

/** Unwrap a successful bridge envelope. Call bridgeFailureResponse first;
 *  throws if the envelope is not a success (a bug in the calling tool). */
export function unwrapBridgeResult(bridged: BridgeResult): Record<string, unknown> {
  if (!bridged.ok || bridged.result == null) {
    throw new Error(`unwrapBridgeResult called on a failed bridge envelope: ${bridged.error ?? "unknown error"}`);
  }
  return bridged.result as Record<string, unknown>;
}
