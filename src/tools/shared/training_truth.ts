/**
 * training_truth.ts: the connector's one reader of the program's truth (1.4.1 D2,
 * connector truth).
 *
 * The program week, phase, schedule and the week's counts are decided in the app's
 * backend, once, and read here over the coreToolsBridge (`get_training_truth`).
 * Before this, each tool computed its own: `get_active_program` took the first week
 * with an unfinished session, `get_training_overview` the highest built week, and
 * `get_weekly_debrief` quoted a stored "planned" figure that counted bonus sessions,
 * so ChatGPT and Claude showed a different week and different counts from the app.
 *
 * This module only reads and words. It never recomputes a week, a phase or a count.
 * Plain wording for facts the backend returns as closed values lives here, so every
 * tool says the same thing: a build state, which program is primary, and that the
 * Manual Workouts container is a log.
 */

import { callCoreBridge } from "./bridge_client.js";
import { logServer } from "../../logger.js";

/** `WeekCounts` from the backend (`services/week_counts.ts`). */
export interface TruthWeekCounts {
  basis: "program" | "all_sessions_legacy";
  programCompleted: number;
  programPlanned: number;
  allSessionsPlanned?: number;
  bonusCompleted: number;
  totalCompleted: number;
  line: string;
}

export type TruthBuildState =
  | "fully_built"
  | "builds_as_you_train"
  | "creating"
  | "paused"
  | "build_failed"
  | "ended";

export interface TruthProgram {
  queueId: string;
  title: string | null;
  kind: "program" | "manual_log";
  role: "primary" | "additional" | "log";
  isPrimary: boolean;
  planState: string | null;
  generationStatus: string | null;
  startsOn: string | null;
  endsOn: string | null;
  declaredWeeks: number | null;
  builtThroughWeek: number;
  currentWeek: number | null;
  weekSource: "calendar" | "sessions";
  notStarted: boolean;
  weekStartsOn: string | null;
  weekEndsOn: string | null;
  phase: { phase: string | null; weeks: string; focus: string | null } | null;
  phases: Array<{ phase: string | null; weeks: string; focus: string | null; isCurrent: boolean }>;
  buildState: TruthBuildState | null;
  nextUnbuiltWeek: number | null;
  nextUnbuiltWeekStartsOn: string | null;
  programEnded: { endedOn: string } | null;
  schedule: Array<{ week: number; startsOn: string | null; built: boolean; plannedSessions: number; completedSessions: number }>;
  currentWeekSessions: Array<{
    sessionId: string | null;
    focus: string | null;
    slotType: string | null;
    scheduledDate: string | null;
    isCompleted: boolean;
  }>;
  completion: { sessionsCompleted: number; sessionsTotal: number; completionPercent: number };
}

export interface TruthDebrief {
  weekStarting: string;
  summary?: string;
  metrics?: {
    sessionsCompleted?: number;
    sessionsPlanned?: number;
    completionRate?: number;
    avgRpe?: number;
    benchmarkPRs?: string[];
    improvingExercises?: string[];
    plateauExercises?: string[];
    weekCounts?: TruthWeekCounts;
    currentBenchmarks?: string[];
    newPrs?: Array<{ exerciseName: string; value: number; previousValue: number | null; date: string }>;
  };
  nextWeekFocus?: string;
  generatedAt?: string;
  fallback?: boolean;
}

export interface TrainingTruth {
  asOf: string;
  timezone: string;
  today: string;
  week: { weekId: string; weekEndId: string; isCurrent: boolean };
  weekCounts: TruthWeekCounts | null;
  primaryQueueId: string | null;
  programs: TruthProgram[];
  debrief?: TruthDebrief;
  debriefIsForWeek?: boolean;
}

export interface TruthInput {
  /** Any date (YYYY-MM-DD) inside the week to count. */
  weekDate?: string;
  includeDebrief?: boolean;
}

/** Reads the truth for a person; null when the app's backend could not answer. Injectable for tests. */
export type TruthReader = (profileId: string, input?: TruthInput) => Promise<TrainingTruth | null>;

/**
 * Production reader: the coreToolsBridge. A failure is logged (no profile id, no
 * message body) and returned as null; each tool decides what an honest answer looks
 * like without it. The connector never falls back to computing its own week.
 */
export const readTrainingTruth: TruthReader = async (profileId, input = {}) => {
  try {
    const bridged = await callCoreBridge("get_training_truth", profileId, { ...input });
    if (!bridged.ok || bridged.result == null) {
      logServer("get_training_truth failed", { error: bridged.error ?? "unknown" });
      return null;
    }
    const result = bridged.result as Partial<TrainingTruth>;
    // A shape the connector does not understand is treated as "could not read", so the
    // athlete gets the plain message instead of a raw error.
    if (typeof result !== "object" || !Array.isArray(result.programs)) {
      logServer("get_training_truth unexpected shape", { error: "programs missing" });
      return null;
    }
    return result as TrainingTruth;
  } catch (err) {
    logServer("get_training_truth unreachable", { error: (err as Error).message });
    return null;
  }
};

export const TRUTH_UNAVAILABLE_MESSAGE =
  "Pelaris could not read your program right now. Try again in a moment. Your program in the app is unaffected.";

// ── Plain wording ────────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Sat 24 Oct" from a YYYY-MM-DD day key (Pelaris's one date style), or null. */
export function plainDay(dayKey: string | null | undefined): string | null {
  if (typeof dayKey !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(dayKey)) return null;
  const [y, m, d] = dayKey.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(date.getTime())) return null;
  return `${WEEKDAYS[date.getUTCDay()]} ${d} ${MONTHS[m - 1]}`;
}

/** What `generation_status` `pending_deferred` and friends mean, in the athlete's terms. */
export function generationStatusPlain(status: string | null | undefined): string | null {
  switch (status) {
    case "pending_deferred":
      return "The next weeks build as you train.";
    case "complete":
      return "The program is fully built.";
    case "generating":
      return "The program is still being created.";
    case "generating_deferred":
      return "The next weeks are being built now.";
    case "deferred_failed":
      return "The last attempt to build the next weeks did not finish.";
    default:
      return null;
  }
}

/** One sentence on how far the program is built. Never says "error" for the by-design rolling build. */
export function buildStateNote(p: TruthProgram): string | null {
  if (p.kind !== "program" || p.buildState == null) return null;
  const built = p.builtThroughWeek;
  const total = p.declaredWeeks;
  switch (p.buildState) {
    case "fully_built":
      return total != null
        ? `All ${total} ${total === 1 ? "week is" : "weeks are"} planned.`
        : `${built} ${built === 1 ? "week is" : "weeks are"} planned.`;
    case "builds_as_you_train": {
      const from = plainDay(p.nextUnbuiltWeekStartsOn);
      const of = total != null ? ` of ${total}` : "";
      const planned = built == null || built < 1
        ? "No weeks are planned yet"
        : built === 1 ? `Week 1${of} is planned` : `Weeks 1 to ${built}${of} are planned`;
      return `${planned}. The next weeks build as you train, so they are not listed yet` +
        `${p.nextUnbuiltWeek != null && from != null ? ` (week ${p.nextUnbuiltWeek} starts ${from})` : ""}. ` +
        "This is how Pelaris works, not a fault.";
    }
    case "creating":
      return "The program is still being created.";
    case "paused":
      return "Building the next weeks is paused. Open Pelaris to see why.";
    case "build_failed":
      return "The last attempt to build the next weeks did not finish. Open the program in Pelaris to retry.";
    case "ended": {
      const on = plainDay(p.programEnded?.endedOn);
      return on != null ? `This program finished on ${on}.` : "This program has finished.";
    }
  }
}

/** Which program is primary, and that Manual Workouts is a log, in words. */
export function roleNote(p: TruthProgram): string {
  if (p.kind === "manual_log") {
    return "Manual Workouts is a log of the sessions you added yourself. It is not a plan, so it has no weeks or phases.";
  }
  return p.isPrimary ? "This is your main program." : "This program is also running. Your main program is the other one.";
}

/** "Week 9 of 24, Base 2" or the honest reason there is no current week. */
export function weekLine(p: TruthProgram): string | null {
  if (p.kind !== "program") return null;
  if (p.notStarted) {
    const on = plainDay(p.startsOn);
    return on != null ? `Starts ${on}.` : "Not started yet.";
  }
  if (p.currentWeek == null) {
    return p.programEnded != null ? "Finished." : "Current week unknown.";
  }
  const of = p.declaredWeeks != null ? ` of ${p.declaredWeeks}` : "";
  const phase = p.phase?.phase ? `, ${p.phase.phase}` : "";
  return `Week ${p.currentWeek}${of}${phase}`;
}

/**
 * The additive fields every program-reading tool carries, from the backend's truth.
 * Existing fields keep their names; these are added beside them.
 */
export function programTruthFields(p: TruthProgram): Record<string, unknown> {
  return {
    kind: p.kind,
    role: p.role,
    isPrimary: p.isPrimary,
    roleNote: roleNote(p),
    ...(p.kind === "program"
      ? {
          weekLine: weekLine(p),
          declaredWeeks: p.declaredWeeks,
          builtThroughWeek: p.builtThroughWeek,
          startsOn: p.startsOn,
          endsOn: p.endsOn,
          weekStartsOn: p.weekStartsOn,
          weekEndsOn: p.weekEndsOn,
          weekSource: p.weekSource,
          buildState: p.buildState,
          buildNote: buildStateNote(p),
          nextUnbuiltWeek: p.nextUnbuiltWeek,
          nextUnbuiltWeekStartsOn: p.nextUnbuiltWeekStartsOn,
          phases: p.phases,
          schedule: p.schedule,
        }
      : {}),
    generationStatusPlain: generationStatusPlain(p.generationStatus),
  };
}
