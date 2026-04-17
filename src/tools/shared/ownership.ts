/**
 * Ownership verification helpers — H-03 (Cluster 02 / Open Water audit).
 *
 * MCP write tools historically scoped queries by `claims.profile_id` (which
 * structurally blocks cross-tenant IDOR), but accepted user-supplied
 * `sessionId` / `queueId` values without verifying the resource still belongs
 * to the user's *active* program. An AI agent (or token holder) could target
 * archived programs, foreign-imported sessions, or guessed IDs.
 *
 * These helpers add defence-in-depth using the existing `active_queues`
 * source-of-truth pattern (PEL-220 / `firestore-client.ts:getActiveQueueDocuments`).
 *
 * Soft-launch: env var `OWNERSHIP_VERIFICATION_LOG_ONLY=true` downgrades
 * throws to console.warn so the first 24h post-deploy can fix any unforeseen
 * legacy carve-out before enforcement bites real users.
 */

import type { DocumentSnapshot } from "firebase-admin/firestore";
import {
  db,
  profileSubcollection,
  getActiveQueueDocuments,
} from "../../firestore-client.js";

export interface OwnershipResult {
  doc: DocumentSnapshot;
  data: Record<string, unknown>;
  /** True when the session has no `origin_queue_id` and was allowed under the legacy carve-out. */
  legacyOrigin: boolean;
}

export type OwnershipErrorCode =
  | "session_not_found"
  | "session_not_owned"
  | "queue_not_active";

export class OwnershipError extends Error {
  constructor(
    public readonly code: OwnershipErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OwnershipError";
  }
}

function logOnlyMode(): boolean {
  return process.env.OWNERSHIP_VERIFICATION_LOG_ONLY === "true";
}

function maybeThrow(error: OwnershipError): never | void {
  if (logOnlyMode()) {
    console.warn(
      `[ownership][LOG_ONLY] would deny: ${error.code} — ${error.message}`,
    );
    return; // soft-launch: do not throw
  }
  throw error;
}

/**
 * Verify a diary session belongs to one of the user's active queues.
 *
 * Returns the loaded session snapshot if owned; throws `OwnershipError` otherwise
 * (or warns in LOG_ONLY mode and returns the data anyway).
 *
 * Policy:
 *  - session not found in user's diary             -> session_not_found
 *  - session has origin_queue_id ∈ active_queues   -> OK
 *  - session has origin_queue_id NOT in active     -> session_not_owned
 *  - session has NO origin_queue_id                -> OK with `legacyOrigin: true`
 *    (back-compat for legacy + MCP-created sessions; observed via logs)
 */
export async function verifySessionOwnership(
  profileId: string,
  sessionId: string,
): Promise<OwnershipResult> {
  const docRef = profileSubcollection(profileId, "diary").doc(sessionId);
  const snap = await docRef.get();

  if (!snap.exists) {
    const err = new OwnershipError(
      "session_not_found",
      `Session "${sessionId}" not found. Use get_training_overview to list your active sessions.`,
    );
    maybeThrow(err);
    // In LOG_ONLY mode the caller still needs *some* shape — but a missing doc
    // genuinely cannot proceed. Throw regardless, since downstream code would
    // fault anyway trying to read fields off a non-existent doc.
    throw err;
  }

  const data = snap.data() as Record<string, unknown>;
  const originQueueId = (data.origin_queue_id ?? data.originQueueId) as
    | string
    | undefined;

  // Legacy / MCP-created sessions with no origin: allow but mark.
  if (!originQueueId) {
    return { doc: snap, data, legacyOrigin: true };
  }

  // Verify origin queue is in profile.active_queues
  const profileSnap = await db.collection("profiles").doc(profileId).get();
  const profileData = (profileSnap.data() ?? {}) as Record<string, unknown>;
  const activeQueueIds = new Set(
    ((profileData.active_queues ?? []) as Array<Record<string, unknown>>)
      .filter((q) => q.is_active === true)
      .map((q) => q.queue_id as string),
  );

  if (!activeQueueIds.has(originQueueId)) {
    const err = new OwnershipError(
      "session_not_owned",
      `Session "${sessionId}" belongs to a program that is no longer active. Archived programs can't be modified — use get_training_overview to see active sessions.`,
    );
    maybeThrow(err);
    // LOG_ONLY: continue with the data so we can observe what would have
    // been blocked without breaking the caller.
    return { doc: snap, data, legacyOrigin: false };
  }

  return { doc: snap, data, legacyOrigin: false };
}

/**
 * Verify a queue ID belongs to the user's active_queues set.
 * Used by manage_program.ts for archive / pause / resume operations.
 */
export async function verifyQueueOwnership(
  profileId: string,
  queueId: string,
): Promise<DocumentSnapshot> {
  const { profileData } = await getActiveQueueDocuments(profileId);
  const activeQueueIds = new Set(
    ((profileData.active_queues ?? []) as Array<Record<string, unknown>>)
      .filter((q) => q.is_active === true)
      .map((q) => q.queue_id as string),
  );

  if (!activeQueueIds.has(queueId)) {
    const err = new OwnershipError(
      "queue_not_active",
      `Program "${queueId}" is not in your active programs. Use get_program_status to list active programs.`,
    );
    maybeThrow(err);
    // LOG_ONLY: load anyway so the tool can inspect it. Caller still gets a
    // snapshot, but downstream operation may legitimately succeed in shadow.
  }

  const docRef = profileSubcollection(profileId, "queues").doc(queueId);
  const snap = await docRef.get();
  if (!snap.exists) {
    throw new OwnershipError(
      "session_not_found",
      `Program "${queueId}" not found.`,
    );
  }
  return snap;
}

/**
 * Convenience: convert an OwnershipError into the standard MCP write-tool
 * error envelope. Tools call this in their catch block to keep call-sites
 * tidy and consistent.
 */
export function ownershipErrorResponse(err: OwnershipError): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ success: false, error: err.message }),
      },
    ],
    isError: true,
  };
}
