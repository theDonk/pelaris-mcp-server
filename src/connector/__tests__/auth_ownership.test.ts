/**
 * B2a C6 (c) through the real `verifyBearerToken` (node:test): a forged or
 * re-pointed token gets 401 and NOTHING is written (P2-6); an allowed token
 * proceeds with its connector facts; a Firestore read error fails open
 * without facts. The secret and every id are synthetic. Firestore is never
 * reached: the token reader is injected and `db.collection` is recorded.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

const SECRET = "local-test-gateway-jwt-secret-0123456789abcdef";
process.env.MCP_JWT_SECRET = SECRET;

const { verifyBearerToken, __setTokenAccessReaderForTest } = await import("../../auth.js");
const { db } = await import("../../firestore-client.js");

const UID = "uid_gw_mw_00001";
const touched: string[] = [];
const realCollection = db.collection.bind(db);

before(() => {
  (db as unknown as { collection: (name: string) => unknown }).collection = (name: string) => {
    touched.push(name);
    const stub = { doc: () => ({ collection: () => stub, update: async () => { throw new Error("stub"); } }) };
    return stub;
  };
});
after(() => {
  (db as unknown as { collection: typeof realCollection }).collection = realCollection;
  __setTokenAccessReaderForTest(null);
});

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signedToken(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const payload = b64url({
    sub: "a".repeat(64), scope: "profile:read training:read", platform: "chatgpt", profile_id: UID,
    client_id: "pelaris-chatgpt", aud: "https://api.pelaris.io/mcp", iat: now, exp: now + 3600, ...overrides,
  });
  const sig = crypto.createHmac("sha256", SECRET).update(`${header}.${payload}`, "utf8").digest("base64url");
  return `${header}.${payload}.${sig}`;
}

interface Outcome { status: number | null; nextCalled: boolean; body: unknown; req: Record<string, unknown> }

async function run(tokenDoc: Record<string, unknown> | null, profile: Record<string, unknown> | null, opts: { throwToken?: boolean } = {}): Promise<Outcome> {
  __setTokenAccessReaderForTest({
    async getTokenDoc() {
      if (opts.throwToken) throw new Error("unavailable");
      return tokenDoc;
    },
    async getProfile() { return profile; },
  });
  touched.length = 0;
  const req = { headers: { authorization: `Bearer ${signedToken()}` } } as Record<string, unknown>;
  const out: Outcome = { status: null, nextCalled: false, body: null, req };
  const res = {
    setHeader: () => undefined,
    status(code: number) { out.status = code; return this; },
    json(body: unknown) { out.body = body; return this; },
  };
  const quiet = { warn: console.warn, error: console.error };
  console.warn = () => undefined;
  console.error = () => undefined;
  try {
    await verifyBearerToken(req as never, res as never, () => { out.nextCalled = true; });
  } finally {
    console.warn = quiet.warn;
    console.error = quiet.error;
  }
  // Let the fire-and-forget last_used_at attempt (allow path only) register.
  await new Promise((r) => setImmediate(r));
  return out;
}

const LIVE = { uid: UID, profile_id: UID, revoked: false, type: "access", assistant_class: "claude" };

test("a forged token with no doc: 401, nothing written [today accepted]", async () => {
  const out = await run(null, null);
  assert.equal(out.status, 401);
  assert.equal(out.nextCalled, false);
  assert.deepEqual(touched, []);
  assert.equal((out.body as { error: string }).error, "invalid_token");
});

test("a token whose profile is someone else's now: 401, nothing written [today accepted]", async () => {
  const out = await run(LIVE, { ownerUid: "uid_someone_else" });
  assert.equal(out.status, 401);
  assert.equal(out.nextCalled, false);
  assert.deepEqual(touched, []);
  assert.equal(out.req.connectorAccess, undefined);
});

test("a revoked token keeps today's answer", async () => {
  const out = await run({ ...LIVE, revoked: true }, { ownerUid: UID });
  assert.equal(out.status, 401);
  assert.deepEqual(out.body, { error: "invalid_token", error_description: "Token has been revoked" });
});

test("the owner's token proceeds with its connector facts and today's last_used_at write", async () => {
  const out = await run(LIVE, { ownerUid: UID });
  assert.equal(out.status, null);
  assert.equal(out.nextCalled, true);
  const access = out.req.connectorAccess as { profileId: string; assistantClass: string };
  assert.equal(access.profileId, UID);
  assert.equal(access.assistantClass, "claude");
  assert.deepEqual(touched, ["profiles"]);
});

test("a Firestore read error fails open with no connector facts and no write (OH-4)", async () => {
  const out = await run(null, null, { throwToken: true });
  assert.equal(out.nextCalled, true);
  assert.equal(out.req.connectorAccess, undefined);
  assert.deepEqual(touched, []);
});
