/**
 * B2a C6 (c): the gateway checks the token's owner on every call
 * (node:test). The vendored rule runs lane A's shared ownership case table;
 * `judgeTokenAccess` runs today's outcome rows with an injected reader, so
 * nothing here touches Firestore.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { readFileSync } from "fs";

import {
  CONNECTOR_OWNERSHIP_CASES_SHA256,
  judgeTokenAccess,
  profileOwnershipVerdict,
  tokenHashOf,
  type TokenAccessReader,
} from "../token_access.js";

const raw = readFileSync(new URL("../../../test_fixtures/connector_ownership_cases.json", import.meta.url), "utf8");
const table = JSON.parse(raw) as {
  cases: Array<{ name: string; profile_id: string; uid: string; profile: Record<string, unknown> | null; verdict: string; owned: boolean }>;
};

test("the ownership case table's canonical digest equals wayfinder's", () => {
  const hash = crypto.createHash("sha256").update(JSON.stringify(JSON.parse(raw)), "utf8").digest("hex");
  assert.equal(hash, CONNECTOR_OWNERSHIP_CASES_SHA256);
});

for (const c of table.cases) {
  test(`ownership rule: ${c.name}`, () => {
    assert.equal(profileOwnershipVerdict(c.profile_id, c.profile ?? undefined, c.uid), c.verdict);
  });
}

const TOKEN = "synthetic.access.token";
const UID = "uid_gw_owner_0001";

function reader(opts: {
  tokenDoc?: Record<string, unknown> | null;
  profile?: Record<string, unknown> | null;
  tokenThrows?: boolean;
  profileThrows?: boolean;
}): TokenAccessReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async getTokenDoc(hash) {
      reads.push(`token:${hash.slice(0, 6)}`);
      if (opts.tokenThrows) throw new Error("unavailable");
      return opts.tokenDoc === undefined ? null : opts.tokenDoc;
    },
    async getProfile(id) {
      reads.push(`profile:${id}`);
      if (opts.profileThrows) throw new Error("unavailable");
      return opts.profile === undefined ? null : opts.profile;
    },
  };
}

const LIVE_DOC = { uid: UID, profile_id: UID, revoked: false, type: "access", client_id: "pelaris-chatgpt", assistant_class: "chatgpt" };

type Row = { today: string; new?: string };
const expected = (row: Row) => row.new ?? row.today;

// Today (abb9a91, auth.ts isTokenRevoked): only an existing revoked doc was refused.
const ROWS: Array<[string, Parameters<typeof reader>[0], Row]> = [
  ["a forged token with no doc", { tokenDoc: null }, { today: "allow", new: "deny:token_doc_missing" }],
  ["a token whose profile is someone else's now", { tokenDoc: LIVE_DOC, profile: { ownerUid: "uid_someone_else" } }, { today: "allow", new: "deny:not_owner" }],
  ["a token for a profile being erased", { tokenDoc: LIVE_DOC, profile: { ownerUid: UID, status: "deletion_pending" } }, { today: "allow", new: "deny:deletion_pending" }],
  ["a token whose profile is gone", { tokenDoc: LIVE_DOC, profile: null }, { today: "allow", new: "deny:profile_missing" }],
  ["a doc stripped by account deletion (C3)", { tokenDoc: { revoked: true, revoked_reason: "account_deleted", type: "access" } }, { today: "deny:revoked" }],
  ["a doc without uid or profile id", { tokenDoc: { revoked: false, type: "access" } }, { today: "allow", new: "deny:token_doc_incomplete" }],
  ["the owner's live token", { tokenDoc: LIVE_DOC, profile: { ownerUid: UID } }, { today: "allow" }],
  ["a Firestore error reading the token doc", { tokenThrows: true }, { today: "allow", new: "fail_open:token_read" }],
  ["a Firestore error reading the profile", { tokenDoc: LIVE_DOC, profileThrows: true }, { today: "allow", new: "fail_open:profile_read" }],
];

for (const [name, opts, row] of ROWS) {
  test(`gateway: ${name} [today ${row.today}${row.new ? `, new ${row.new}` : ""}]`, async () => {
    const access = await judgeTokenAccess(TOKEN, { profile_id: UID }, reader(opts));
    const label = access.kind === "allow" ? "allow" : access.kind === "deny" ? `deny:${access.reason}` : `fail_open:${access.stage}`;
    assert.equal(label, expected(row));
  });
}

test("a token whose claims name another profile than its doc, or none, is refused", async () => {
  const access = await judgeTokenAccess(TOKEN, { profile_id: "uid_other" }, reader({ tokenDoc: LIVE_DOC, profile: { ownerUid: UID } }));
  assert.deepEqual(access, { kind: "deny", reason: "profile_mismatch" });
  const missing = await judgeTokenAccess(TOKEN, {}, reader({ tokenDoc: LIVE_DOC, profile: { ownerUid: UID } }));
  assert.deepEqual(missing, { kind: "deny", reason: "profile_mismatch" });
});

test("allow carries the stored assistant class; an older token has none", async () => {
  const a = await judgeTokenAccess(TOKEN, { profile_id: UID }, reader({ tokenDoc: LIVE_DOC, profile: { ownerUid: UID } }));
  assert.equal(a.kind === "allow" && a.assistantClass, "chatgpt");
  const b = await judgeTokenAccess(TOKEN, { profile_id: UID }, reader({ tokenDoc: { ...LIVE_DOC, assistant_class: undefined }, profile: { ownerUid: UID } }));
  assert.equal(b.kind === "allow" && b.assistantClass, null);
  const c = await judgeTokenAccess(TOKEN, { profile_id: UID }, reader({ tokenDoc: { ...LIVE_DOC, assistant_class: "Evil" }, profile: { ownerUid: UID } }));
  assert.equal(c.kind === "allow" && c.assistantClass, null);
});

test("one read of the token doc by its hash, then one read of the doc's profile; a denied doc reads nothing more", async () => {
  const r = reader({ tokenDoc: LIVE_DOC, profile: { ownerUid: UID } });
  await judgeTokenAccess(TOKEN, { profile_id: UID }, r);
  assert.deepEqual(r.reads, [`token:${tokenHashOf(TOKEN).slice(0, 6)}`, `profile:${UID}`]);
  const missing = reader({ tokenDoc: null });
  await judgeTokenAccess(TOKEN, { profile_id: UID }, missing);
  assert.equal(missing.reads.length, 1);
});
