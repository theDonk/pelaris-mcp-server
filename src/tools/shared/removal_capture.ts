/**
 * Coach autonomy uplift, P7a (design 3.5): before the gateway deletes a session, bulk deletes sessions or
 * archives a whole program, it saves what is about to go to a SERVER-ONLY store, and tells the assistant what
 * was removed in the result so it can say it.
 *
 * The connector hosts keep their own approval settings (Claude can be set to Always allow; ChatGPT is
 * unverified), and these three writes go straight to Firestore with no core and no copy. So the gateway takes
 * the copy itself. Same store, namespacing and TTL as the coach's chat snapshots (wayfinder
 * `coach/coach_change_capture.ts`): `profiles/{id}/session_versions`, which has no client rule, so the athlete's
 * own app cannot read or write it; `expires_at` carries a Firestore TTL (dial `coach_version_retention_days`
 * on `system_config/ai_models.coach_loop`, read best effort, default 30 days). Erasure already covers the
 * store. Put-back is 1.4.1.
 *
 * Capture is fail open: a copy that cannot be written is logged by code only (never the content) and the
 * athlete's request still goes ahead. The result then says `captured: false`.
 */

import { db, profileSubcollection } from "../../firestore-client.js";

export const GATEWAY_CAPTURE_REQUESTED_BY = {
  delete: "mcp_delete",
  bulkDelete: "mcp_bulk_delete",
  archive: "mcp_archive",
} as const;

export type GatewayCaptureKind = keyof typeof GATEWAY_CAPTURE_REQUESTED_BY;

export const DEFAULT_RETENTION_DAYS = 30;

/** What the assistant is told was removed: closed facts, never notes. */
export interface RemovedSummary {
  title?: string;
  scheduledDate?: string;
  exerciseNames: string[];
}

const MAX_NAMES = 12;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/** Pure: the closed facts about a session about to be removed. */
export function describeRemoved(data: Record<string, unknown>): RemovedSummary {
  const names: string[] = [];
  const blocks = Array.isArray(data.blocks) ? data.blocks : [];
  for (const block of blocks) {
    const exercises = (block as Record<string, unknown> | null)?.exercises;
    for (const ex of Array.isArray(exercises) ? exercises : []) {
      if (names.length >= MAX_NAMES) break;
      const name = str((ex as Record<string, unknown>)?.exercise_name) ?? str((ex as Record<string, unknown>)?.name);
      if (name) names.push(name);
    }
  }
  const date = str(data.scheduled_date)?.slice(0, 10);
  return {
    title: str(data.title) ?? str(data.focus),
    scheduledDate: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
    exerciseNames: names,
  };
}

/** Pure: the version row. Same shape as the engine's `session_versions` rows plus the TTL and a target type. */
export function buildRemovalVersionRow(input: {
  kind: GatewayCaptureKind;
  sessionOrQueueId: string;
  queueId: string;
  previous: Record<string, unknown>;
  targetType: "diary_session" | "queue";
  nowMs: number;
  retentionDays: number;
}): Record<string, unknown> {
  return {
    queue_id: input.queueId,
    session_id: input.sessionOrQueueId,
    requested_by: GATEWAY_CAPTURE_REQUESTED_BY[input.kind],
    reason: input.kind,
    replaced_at: new Date(input.nowMs).toISOString(),
    previous: input.previous,
    target_type: input.targetType,
    expires_at: new Date(input.nowMs + input.retentionDays * 24 * 60 * 60 * 1000),
  };
}

/** The retention dial, read best effort from the shared config document. Never throws. */
export async function readRetentionDays(): Promise<number> {
  try {
    const snap = await db.doc("system_config/ai_models").get();
    const coachLoop = (snap.data() ?? {}).coach_loop as Record<string, unknown> | undefined;
    const value = coachLoop?.coach_version_retention_days;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_RETENTION_DAYS;
  } catch {
    return DEFAULT_RETENTION_DAYS;
  }
}

/**
 * Save the copy BEFORE the removal. Returns true when written. `write` and `retentionDays` are injectable for
 * tests; the default writes to the athlete's `session_versions`.
 */
export async function captureBeforeRemoval(
  input: {
    profileId: string;
    kind: GatewayCaptureKind;
    sessionOrQueueId: string;
    queueId?: string;
    previous: Record<string, unknown>;
    targetType: "diary_session" | "queue";
    nowMs?: number;
  },
  deps: {
    write?: (profileId: string, row: Record<string, unknown>) => Promise<void>;
    retentionDays?: () => Promise<number>;
  } = {},
): Promise<boolean> {
  try {
    const days = await (deps.retentionDays ?? readRetentionDays)();
    const origin = typeof input.previous.origin_queue_id === "string" ? input.previous.origin_queue_id : "";
    const row = buildRemovalVersionRow({
      kind: input.kind,
      sessionOrQueueId: input.sessionOrQueueId,
      queueId: input.queueId ?? origin,
      previous: input.previous,
      targetType: input.targetType,
      nowMs: input.nowMs ?? Date.now(),
      retentionDays: days,
    });
    await (deps.write ?? (async (profileId, r) => {
      await profileSubcollection(profileId, "session_versions").doc().set(r);
    }))(input.profileId, row);
    return true;
  } catch {
    console.warn(`[removal_capture] copy not written kind=${input.kind} profile=${input.profileId.slice(0, 6)}`);
    return false;
  }
}
