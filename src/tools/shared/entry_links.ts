/**
 * Entry links handed by the connector to an assistant.
 *
 * Plain links open `/start/<route>` in Pelaris. When the verified connector
 * request facts carry `uid` and `profileId`, `mintSignedEntryLink` writes a single-use,
 * 10-minute SHA-256 token record to `handoff_tokens/{tokenHash}` and returns
 * `https://coach.pelaris.io/start/<route>?h=<opaqueToken>`, falling back cleanly
 * to the plain `/start/<route>` link if credentials are absent or storage fails.
 */

import crypto from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { currentConnectorFacts, type ConnectorFacts } from "../../connector/connector_use.js";
import { assertAllowedCollection, db } from "../../firestore-client.js";

export const ENTRY_BASE_URL = "https://coach.pelaris.io/start";

export const ENTRY_LINK_PROGRAM = "https://coach.pelaris.io/start/program";
export const ENTRY_LINK_TRAIN = "https://coach.pelaris.io/start/train";
export const ENTRY_LINK_SCAN = "https://coach.pelaris.io/start/scan";
export const ENTRY_LINK_BODY = "https://coach.pelaris.io/start/body";
export const ENTRY_LINK_CALCULATORS = "https://coach.pelaris.io/start/calculators";

export const HANDOFF_ROUTES = [
  "program",
  "train",
  "scan",
  "body",
  "calculators",
] as const;

export type HandoffRoute = (typeof HANDOFF_ROUTES)[number];

export const HANDOFF_TOKENS_COLLECTION = "handoff_tokens";
export const HANDOFF_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const HANDOFF_TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,64}$/;

const SAFE_ID_SHAPE = /^[A-Za-z0-9._-]{1,128}$/;

export function isHandoffRoute(value: unknown): value is HandoffRoute {
  return (
    typeof value === "string" &&
    (HANDOFF_ROUTES as readonly string[]).includes(value)
  );
}

export function plainEntryLink(route: HandoffRoute): string {
  if (!isHandoffRoute(route)) {
    throw new Error("Unsupported entry route");
  }
  return `${ENTRY_BASE_URL}/${route}`;
}

export function hashHandoffToken(opaqueToken: string): string {
  return crypto.createHash("sha256").update(opaqueToken, "utf8").digest("hex");
}

function isSafeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SAFE_ID_SHAPE.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

export interface HandoffClaimsLike {
  uid?: string | null;
  profile_id?: string | null;
  profileId?: string | null;
}

export interface HandoffTokenRecord {
  uid: string;
  profile_id: string;
  route: HandoffRoute;
  issued_by: "connector";
  created_at: FirebaseFirestore.FieldValue;
  expire_at: FirebaseFirestore.Timestamp;
  consumed_at: null;
}

export interface MintSignedEntryLinkDeps {
  nowMs?: () => number;
  generateToken?: () => string;
  getConnectorFacts?: () => ConnectorFacts | null;
  writeTokenDoc?: (tokenHash: string, data: HandoffTokenRecord) => Promise<void>;
}

async function defaultWriteTokenDoc(
  tokenHash: string,
  data: HandoffTokenRecord,
): Promise<void> {
  assertAllowedCollection(HANDOFF_TOKENS_COLLECTION);
  await db.collection(HANDOFF_TOKENS_COLLECTION).doc(tokenHash).create(data);
}

/**
 * Mints a short-lived signed entry link for `route`, or falls back to the plain
 * `/start/<route>` link when `uid`/`profile_id` are unavailable or Firestore fails.
 */
export async function mintSignedEntryLink(
  route: HandoffRoute,
  claims: HandoffClaimsLike | null | undefined,
  deps: MintSignedEntryLinkDeps = {},
): Promise<string> {
  const fallback = plainEntryLink(route);

  // Identity comes only from the verified connector request facts. Claims may
  // only narrow: a claims profile id that differs from the facts gets the plain link.
  const facts = (deps.getConnectorFacts ?? currentConnectorFacts)();
  if (!facts) return fallback;
  const rawProfileId =
    typeof facts.profileId === "string" ? facts.profileId.trim() : "";
  const rawUid = typeof facts.uid === "string" ? facts.uid.trim() : "";
  if (!isSafeId(rawProfileId) || !isSafeId(rawUid)) return fallback;

  const claimsProfileId =
    typeof claims?.profile_id === "string" && claims.profile_id.trim().length > 0
      ? claims.profile_id.trim()
      : typeof claims?.profileId === "string" && claims.profileId.trim().length > 0
        ? claims.profileId.trim()
        : "";
  if (claimsProfileId && claimsProfileId !== rawProfileId) return fallback;

  try {
    const opaqueToken = (
      deps.generateToken ?? (() => crypto.randomBytes(32).toString("base64url"))
    )();
    if (!HANDOFF_TOKEN_SHAPE.test(opaqueToken)) {
      return fallback;
    }
    const tokenHash = hashHandoffToken(opaqueToken);
    const nowMs = (deps.nowMs ?? Date.now)();
    const writeFn = deps.writeTokenDoc ?? defaultWriteTokenDoc;

    await writeFn(tokenHash, {
      uid: rawUid,
      profile_id: rawProfileId,
      route,
      issued_by: "connector",
      created_at: FieldValue.serverTimestamp(),
      expire_at: Timestamp.fromMillis(nowMs + HANDOFF_TTL_MS),
      consumed_at: null,
    });

    return `${fallback}?h=${opaqueToken}`;
  } catch {
    return fallback;
  }
}
