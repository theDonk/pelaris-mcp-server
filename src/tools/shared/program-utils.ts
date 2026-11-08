/**
 * Shared program utilities for MCP tools.
 * Extracted from manage_program.ts for reuse across get_program_status + archive_program.
 *
 * Connector rev 2.1 (22/10/2026, M2): a program's status is what the APP says it is. The old
 * `status: "archived"` marker was written by the connector's former archive, was read by nothing
 * but this server, and is no longer read here. A program Remove took away carries
 * `generation_status: "removed"` on its queue doc and `removed_at` on its entry in the person's
 * own list; a replaced one carries `superseded_by` or `retired_at`; a paused one `is_active: false`.
 * The entry state comes from the gateway's pinned copy of the app's plan-state rule
 * (`connector/return_hook.ts`), so `get_program_status` never lists a removed program as running.
 */

import type { QueryDocumentSnapshot, DocumentSnapshot } from "firebase-admin/firestore";
import {
  isSet,
  planEntriesOf,
  planEntryQueueId,
  isManualEntry,
  planStateOf,
} from "../../connector/return_hook.js";
import { ENTRY_LINK_TRAIN } from "./entry_links.js";

type Raw = Record<string, unknown>;

/** Whether the program's rolling weekly adaptation is running or paused (e.g. free JIT allowance ended). */
export type AdaptationState = "active" | "paused";

/**
 * Returns `"paused"` when `queue.jit_state === "paused_entitlement"` (the JIT scheduler has stopped
 * building new weeks because the free allowance ended) or when the backend truth reports
 * `buildState === "paused"`. Every MCP tool continues to work in either state; this is informational only.
 */
export function adaptationStateOf(queue: Raw, truthBuildState?: string | null): AdaptationState {
  if (queue["jit_state"] === "paused_entitlement" || truthBuildState === "paused") return "paused";
  return "active";
}

/**
 * Returns the latest scheduled session date (`YYYY-MM-DD`) found in `queue.weeks[].sessions[]` or the
 * flat `queue.sessions[]`, or `null` when no dated sessions exist. Used to tell an athlete how far
 * their written sessions reach when adaptation is paused.
 */
export function materializedThroughDateOf(queue: Raw): string | null {
  const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
  let max: string | null = null;

  function update(candidate: string): void {
    if (max == null || candidate > max) max = candidate;
  }

  function fromSession(s: unknown): void {
    if (s == null || typeof s !== "object") return;
    const session = s as Raw;
    for (const key of ["scheduled_date", "scheduledDate"] as const) {
      const v = session[key];
      if (typeof v === "string" && DATE_RE.test(v)) update(v.slice(0, 10));
    }
    const d = session["date"];
    if (typeof d === "string" && d.length >= 10) {
      const sliced = d.slice(0, 10);
      if (DATE_RE.test(sliced)) update(sliced);
    }
  }

  const weeks = queue["weeks"];
  if (Array.isArray(weeks)) {
    for (const week of weeks) {
      if (week == null || typeof week !== "object") continue;
      const sessions = (week as Raw)["sessions"];
      if (Array.isArray(sessions)) {
        for (const s of sessions) fromSession(s);
      }
    }
  }

  const sessions = queue["sessions"];
  if (Array.isArray(sessions)) {
    for (const s of sessions) fromSession(s);
  }

  return max;
}

/**
 * Plain-language note for a paused adaptation state. When `materializedThroughDate` is non-null the note
 * names when the written sessions run out. Never mentions offers, pricing or discount codes.
 */
export function adaptationNoteFor(materializedThroughDate: string | null): string {
  const through =
    materializedThroughDate != null
      ? ` after your scheduled sessions through ${materializedThroughDate}`
      : "";
  return (
    `Weekly program adaptation is paused${through}. ` +
    "All MCP workout logging and plan tools remain free and active. " +
    `Open Pelaris on Today to resume rolling adaptation: ${ENTRY_LINK_TRAIN}`
  );
}

/**
 * The answer when nothing is running (`get_program_status`, `get_active_program`). A paused program is
 * in the app, so the assistant must not tell the athlete they have none.
 */
export const NO_RUNNING_PROGRAM_MESSAGE =
  "No running program found. If you paused one, it is in Pelaris under Profile with a Resume button.";

/** How the person's program stands, in the app's own terms. */
export type ProgramStatus = "active" | "resting" | "paused" | "replaced" | "removed" | "not_running";

/** The person's own list entries, by queue id (the manual-workouts container included: it is theirs to see). */
export function entriesByQueueId(profile: Raw | null | undefined): Map<string, Raw> {
  const byId = new Map<string, Raw>();
  for (const entry of planEntriesOf(profile)) {
    const id = planEntryQueueId(entry);
    if (id != null) byId.set(id, entry as Raw);
  }
  return byId;
}

/**
 * The newest program the person holds (a running, rested or paused one, never the manual container
 * and never a retired or removed one), by queue id, or null. The list is oldest first, so the newest
 * is the last live entry.
 */
export function heldPlanQueueIdOf(profile: Raw | null | undefined): string | null {
  const entries = planEntriesOf(profile);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (isManualEntry(entry) || planStateOf(entry) === "retired") continue;
    const id = planEntryQueueId(entry);
    if (id != null) return id;
  }
  return null;
}

/**
 * The program's status from its queue doc and its entry in the person's own list (`undefined` when the
 * list has no entry for it: stopped in the app, or finished). Pure; no marker is read.
 */
export function programStatusOf(queue: Raw, entry: Raw | undefined): ProgramStatus {
  const generation = queue["generation_status"];
  if (generation === "removed" || generation === "discarded") return "removed";
  if (entry === undefined) return "not_running";
  switch (planStateOf(entry)) {
    case "retired":
      return isSet(entry["removed_at"]) ? "removed" : "replaced";
    case "resting":
      return "resting";
    case "paused_by_person":
      return "paused";
    case "active":
      return "active";
  }
}

export function summarizeProgram(
  doc: QueryDocumentSnapshot | DocumentSnapshot,
  entries: ReadonlyMap<string, Raw>,
  options?: { plannedTotalWeeks?: number | null },
): Record<string, unknown> {
  const d = doc.data()!;
  const sessions = (d.sessions || []) as Array<Record<string, unknown>>;
  const completed = sessions.filter((s) => s.is_completed).length;
  const weeks = [...new Set(sessions.map((s) => s.week_number as number))].sort((a, b) => a - b);
  const header = d.header != null && typeof d.header === "object" ? (d.header as Raw) : null;
  const entry = entries.get(doc.id);
  const entryWeeks =
    (entry && typeof entry.duration_weeks === "number" ? entry.duration_weeks : null) ??
    (entry && typeof entry.total_weeks === "number" ? entry.total_weeks : null) ??
    (entry && typeof entry.durationWeeks === "number" ? entry.durationWeeks : null) ??
    (entry && typeof entry.declaredWeeks === "number" ? entry.declaredWeeks : null);
  const declaredWeeksRaw =
    options?.plannedTotalWeeks ??
    entryWeeks ??
    (typeof d.duration_weeks === "number" ? d.duration_weeks : null) ??
    (typeof d.total_weeks === "number" ? d.total_weeks : null) ??
    (header && typeof header.durationWeeks === "number" ? header.durationWeeks : null) ??
    (header && typeof header.duration_weeks === "number" ? header.duration_weeks : null);
  const totalWeeks =
    typeof declaredWeeksRaw === "number" && declaredWeeksRaw > weeks.length
      ? declaredWeeksRaw
      : weeks.length;

  const adaptationState = adaptationStateOf(d);
  const materializedThroughDate = materializedThroughDateOf(d);
  return {
    programId: doc.id,
    title: d.title || null,
    type: d.type || null,
    totalSessions: sessions.length,
    completedSessions: completed,
    completionPercent: sessions.length > 0 ? Math.round((completed / sessions.length) * 100) : 0,
    totalWeeks,
    materializedWeeks: weeks.length,
    generationStatus: d.generation_status || null,
    status: programStatusOf(d, entries.get(doc.id)),
    dateCreated: d.date_created?.toDate?.()?.toISOString?.() || null,
    removedAt: d.removed_at?.toDate?.()?.toISOString?.() || null,
    adaptationState,
    materializedThroughDate,
    ...(adaptationState === "paused"
      ? { adaptationNote: adaptationNoteFor(materializedThroughDate), link: ENTRY_LINK_TRAIN }
      : {}),
  };
}
