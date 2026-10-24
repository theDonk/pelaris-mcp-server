/**
 * Who may use an OAuth access token at the gateway (Pelaris 1.4 B2a lane C,
 * C6 c; batch 0 review carry-in; panel P4-1, P2-6, P4-11).
 *
 * After the JWT verifies: one read of `mcp_tokens/{hash}`, then one read
 * of `profiles/{doc.profile_id}`, judged by the VENDORED ownership rule
 * (wayfinder `mcp/connector_access.ts` `profileOwnershipVerdict`, pinned to the
 * shared case table `test_fixtures/connector_ownership_cases.json`):
 *   - revoked doc, missing doc, a doc without uid or profile id, a doc whose
 *     profile id differs from the token's, a missing or `deletion_pending`
 *     profile, or a profile owned by someone else: DENY (401). Nothing is
 *     written on a denial (P2-6);
 *   - only a Firestore READ ERROR fails open (OH-4, low friction), with one
 *     log line; the caller then skips the return hook and `connector_use`.
 * Pure over an injected reader, so tests never touch Firestore.
 */
import crypto from "crypto";

/** Canonical SHA-256 of `test_fixtures/connector_ownership_cases.json` (equal to wayfinder's). */
export const CONNECTOR_OWNERSHIP_CASES_SHA256 = "357a11523d352a1fff6eea3f55b6d1cba200da96dab50c4d8dbbdf90c2a5c2e7";

export type ProfileOwnershipVerdict = "owned" | "missing" | "deletion_pending" | "not_owner";

/** VENDORED verbatim in behaviour from wayfinder `profileOwnershipVerdict`. */
export function profileOwnershipVerdict(
  profileId: string,
  profileData: Record<string, unknown> | undefined | null,
  uid: string,
): ProfileOwnershipVerdict {
  if (!profileId || !profileData) return "missing";
  if (profileData.status === "deletion_pending") return "deletion_pending";
  if (!uid) return "not_owner";
  const ownerUid = profileData.ownerUid;
  if (ownerUid === uid) return "owned";
  const ownerUnset = ownerUid === null || ownerUid === undefined || ownerUid === "";
  return profileId === uid && ownerUnset ? "owned" : "not_owner";
}

export const ASSISTANT_CLASSES = ["chatgpt", "claude", "other"] as const;
export type AssistantClass = typeof ASSISTANT_CLASSES[number];

export type TokenDenyReason =
  | "revoked"
  | "token_doc_missing"
  | "token_doc_incomplete"
  | "profile_mismatch"
  | "profile_missing"
  | "deletion_pending"
  | "not_owner";

export type TokenAccess =
  | {
    kind: "allow";
    profileId: string;
    profileData: Record<string, unknown>;
    /** The token doc's stored class (lane A stamps it at mint), or null for an older token. */
    assistantClass: AssistantClass | null;
  }
  | { kind: "deny"; reason: TokenDenyReason }
  | { kind: "fail_open"; stage: "token_read" | "profile_read" };

export interface TokenAccessReader {
  /** The token doc, or null when it does not exist. Throws on a read error. */
  getTokenDoc(tokenHash: string): Promise<Record<string, unknown> | null>;
  /** The profile doc, or null when it does not exist. Throws on a read error. */
  getProfile(profileId: string): Promise<Record<string, unknown> | null>;
}

export function tokenHashOf(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** Judge one access token. Never throws. */
export async function judgeTokenAccess(
  token: string,
  claims: { profile_id?: unknown },
  reader: TokenAccessReader,
): Promise<TokenAccess> {
  let tokenDoc: Record<string, unknown> | null;
  try {
    tokenDoc = await reader.getTokenDoc(tokenHashOf(token));
  } catch {
    return { kind: "fail_open", stage: "token_read" };
  }
  if (tokenDoc == null) return { kind: "deny", reason: "token_doc_missing" };
  if (tokenDoc.revoked === true) return { kind: "deny", reason: "revoked" };
  const uid = tokenDoc.uid;
  const profileId = tokenDoc.profile_id;
  if (typeof uid !== "string" || uid === "" || typeof profileId !== "string" || profileId === "") {
    return { kind: "deny", reason: "token_doc_incomplete" };
  }
  // The tools act on the token's profile_id claim, so it must name exactly
  // the doc's profile (a missing claim is a mismatch too).
  if (claims.profile_id !== profileId) {
    return { kind: "deny", reason: "profile_mismatch" };
  }
  let profileData: Record<string, unknown> | null;
  try {
    profileData = await reader.getProfile(profileId);
  } catch {
    return { kind: "fail_open", stage: "profile_read" };
  }
  const verdict = profileOwnershipVerdict(profileId, profileData, uid);
  if (verdict === "missing") return { kind: "deny", reason: "profile_missing" };
  if (verdict !== "owned") return { kind: "deny", reason: verdict };
  const stored = tokenDoc.assistant_class;
  const assistantClass = typeof stored === "string" && (ASSISTANT_CLASSES as readonly string[]).includes(stored) ?
    stored as AssistantClass :
    null;
  return { kind: "allow", profileId, profileData: profileData as Record<string, unknown>, assistantClass };
}

/** The production reader: two single-document reads. */
export async function firestoreTokenAccessReader(): Promise<TokenAccessReader> {
  const { db } = await import("../firestore-client.js");
  return {
    async getTokenDoc(tokenHash) {
      const snap = await db.collection("mcp_tokens").doc(tokenHash).get();
      return snap.exists ? (snap.data() ?? {}) : null;
    },
    async getProfile(profileId) {
      const snap = await db.collection("profiles").doc(profileId).get();
      return snap.exists ? (snap.data() ?? {}) : null;
    },
  };
}
