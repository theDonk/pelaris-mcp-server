/**
 * The gateway's connector routes (B2a fix pass; node:test): `/register`,
 * `/token`, `/revoke` and the `/mcp` return step, through a real Express app
 * with Firestore, the limiter, the bridge and the function stubbed. Synthetic
 * values only (TEST-NET addresses, a fixture secret, no real id).
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { readFileSync } from "node:fs";

import { __resetDcrRefusedAlertForTest } from "../dcr_guard.js";
import { DEFAULT_GATEWAY_DIALS, type GatewayDials } from "../dials.js";
import { __resetReturnHookCacheForTest, type BridgeCall } from "../return_hook.js";
import { mountConnectorRoutes, runConnectorReturnStep, type DcrLimitExceeded, type RouteDeps } from "../routes.js";

// ── Harness ─────────────────────────────────────────────────────────────────

interface FakeDoc { data: Record<string, unknown> }

function fakeFirestore() {
  const docs = new Map<string, FakeDoc>();
  return {
    docs,
    db: {
      collection(name: string) {
        return {
          doc(id: string) {
            const path = `${name}/${id}`;
            return {
              get: async () => ({ exists: docs.has(path), data: () => docs.get(path)?.data }),
              set: async (data: Record<string, unknown>) => {
                docs.set(path, { data });
              },
              create: async (data: Record<string, unknown>) => {
                if (docs.has(path)) throw Object.assign(new Error("exists"), { code: 6 });
                docs.set(path, { data });
              },
            };
          },
        };
      },
    } as unknown as ReturnType<RouteDeps["firestore"]> extends Promise<infer T> ? T : never,
  };
}

/** Counts new registrations per key and refuses past `max`, like the real hourly bucket. */
function countingDcrLimit(max: number) {
  const counts = new Map<string, number>();
  const calls: string[] = [];
  const check = async (key: string, maxRequests: number): Promise<DcrLimitExceeded> => {
    calls.push(key);
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next > Math.min(max, maxRequests) ? { retryAfterSeconds: 1800, maxRequests: Math.min(max, maxRequests) } : null;
  };
  return { calls, check };
}

interface Harness {
  base: string;
  fs: ReturnType<typeof fakeFirestore>;
  logs: Array<Record<string, unknown>>;
  fetches: Array<{ url: string; init: RequestInit }>;
  dcrCalls: string[];
  bridgeCalls: Array<{ tool: string; profileId: string }>;
  close(): Promise<void>;
}

async function harness(options: {
  dials?: Partial<GatewayDials>;
  dcrMax?: number;
  secret?: string;
  upstream?: () => Promise<Response>;
} = {}): Promise<Harness> {
  const fs = fakeFirestore();
  const logs: Array<Record<string, unknown>> = [];
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  const bridgeCalls: Array<{ tool: string; profileId: string }> = [];
  const limit = countingDcrLimit(options.dcrMax ?? 1000);
  const deps: RouteDeps = {
    loadDials: async () => ({ ...DEFAULT_GATEWAY_DIALS, ...options.dials }),
    firestore: async () => fs.db,
    checkDcrLimit: limit.check,
    fetch: (async (url: string, init: RequestInit) => {
      fetches.push({ url: String(url), init });
      return options.upstream ? options.upstream() : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
    oauthBase: "https://oauth.example.test/fn",
    headerSecret: () => options.secret,
    bridge: async (tool, profileId) => {
      bridgeCalls.push({ tool, profileId });
      return { ok: true, result: {} };
    },
    log: (line) => logs.push(line),
  };
  const app = express();
  app.use(express.json());
  mountConnectorRoutes(app, deps);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    fs,
    logs,
    fetches,
    dcrCalls: limit.calls,
    bridgeCalls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const open: Harness[] = [];
async function start(options?: Parameters<typeof harness>[0]): Promise<Harness> {
  const h = await harness(options);
  open.push(h);
  return h;
}
after(async () => {
  await Promise.all(open.map((h) => h.close()));
});
beforeEach(() => __resetDcrRefusedAlertForTest());

async function register(h: Harness, body: unknown, ip = "203.0.113.7"): Promise<Response> {
  return fetch(`${h.base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

// ── SR-5 = CR-7: the DCR limit refuses in every mode ────────────────────────

test("SR-5: with the default log_only mode, the registration past the limit is refused with 429 and Retry-After", async () => {
  const h = await start({ dcrMax: 2 });
  assert.equal(DEFAULT_GATEWAY_DIALS.createLimitMode, "log_only");
  for (let i = 0; i < 2; i += 1) {
    const ok = await register(h, { redirect_uris: [`https://chatgpt.com/connector/oauth/fixture-${i}`] });
    assert.equal(ok.status, 201);
  }
  const refused = await register(h, { redirect_uris: ["https://chatgpt.com/connector/oauth/fixture-2"] });
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("retry-after"), "1800");
  assert.equal((await refused.json() as { error: string }).error, "rate_limit_exceeded");
  // Nothing was written for the refused one.
  assert.equal([...h.fs.docs.keys()].filter((k) => k.startsWith("mcp_clients/")).length, 2);
  const line = h.logs.find((l) => l.event === "dcr_limit_reached");
  assert.deepEqual(line, { severity: "WARNING", event: "dcr_limit_reached", registrar: "gateway", outcome: "refused", limit: 2 });
});

test("SR-5: enforce mode refuses the same way (unchanged)", async () => {
  const h = await start({ dcrMax: 1, dials: { createLimitMode: "enforce" } });
  assert.equal((await register(h, { redirect_uris: ["https://claude.ai/api/mcp/auth_callback/fixture-a"] })).status, 201);
  assert.equal((await register(h, { redirect_uris: ["https://claude.ai/api/mcp/auth_callback/fixture-b"] })).status, 429);
});

test("SR-5: re-registering the same URIs 50 times is answered 200 and is never counted", async () => {
  const h = await start({ dcrMax: 1 });
  const body = { redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"], client_name: "ChatGPT" };
  const first = await register(h, body);
  assert.equal(first.status, 201);
  const clientId = (await first.json() as { client_id: string }).client_id;
  assert.match(clientId, /^dyn-[0-9a-f]{32}$/);
  for (let i = 0; i < 50; i += 1) {
    const again = await register(h, body);
    assert.equal(again.status, 200);
    assert.equal((await again.json() as { client_id: string }).client_id, clientId);
  }
  assert.equal(h.dcrCalls.length, 1, "only the first (new) registration was charged");
});

// ── /register: the rest of the guard (CR-15) ────────────────────────────────

test("a refused scheme answers 400 invalid_redirect_uri, prints the closed dcr_refused line and raises one alert", async () => {
  const h = await start();
  const res = await register(h, { redirect_uris: ["javascript://chatgpt.com/%0Aalert(1)"], client_name: "x" });
  assert.equal(res.status, 400);
  assert.equal((await res.json() as { error: string }).error, "invalid_redirect_uri");
  const line = h.logs.find((l) => l.event === "dcr_refused");
  assert.deepEqual(Object.keys(line ?? {}), ["event", "registrar", "reason", "scheme", "assistant_host"]);
  assert.equal(JSON.stringify(line).includes("alert(1)"), false, "never the refused URI");
  assert.equal([...h.fs.docs.keys()].filter((k) => k.startsWith("admin_alerts/")).length, 1);
  await register(h, { redirect_uris: ["javascript://chatgpt.com/other"] });
  assert.equal([...h.fs.docs.keys()].filter((k) => k.startsWith("admin_alerts/")).length, 1, "one alert a day");
  assert.equal([...h.fs.docs.keys()].filter((k) => k.startsWith("mcp_clients/")).length, 0);
});

test("no redirect_uris answers 400 invalid_request and registers nothing", async () => {
  const h = await start();
  const res = await register(h, {});
  assert.equal(res.status, 400);
  assert.equal((await res.json() as { error: string }).error, "invalid_request");
});

test("the registrant's name is normalised and capped at 64 before it is stored", async () => {
  const h = await start();
  const res = await register(h, { redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: `  Claude‮ ${"x".repeat(200)}  ` });
  assert.equal(res.status, 201);
  const stored = [...h.fs.docs.entries()].find(([k]) => k.startsWith("mcp_clients/"))?.[1].data;
  const name = String(stored?.client_name);
  assert.ok(name.length <= 64);
  assert.equal(name.includes("‮"), false);
});

// ── /token and /revoke: what leaves the gateway (CR-15) ─────────────────────

const SECRET = "fixture-oauth-ip-header-secret-0123456789abcdef";

async function postForm(h: Harness, path: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${h.base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.7", ...headers },
    body: new URLSearchParams(form).toString(),
  });
}

test("/token forwards the form body to the function with headers built from scratch and the client address under the secret", async () => {
  const h = await start({ secret: SECRET });
  const res = await postForm(h, "/token", { grant_type: "authorization_code", code: "fixture-code" }, {
    "x-pelaris-client-ip": "192.0.2.66", // an inbound copy never passes
    "x-pelaris-gateway-secret": "attacker-chosen-value",
    authorization: "Bearer should-not-be-forwarded",
  });
  assert.equal(res.status, 200);
  assert.equal(h.fetches.length, 1);
  const sent = h.fetches[0];
  assert.equal(sent.url, "https://oauth.example.test/fn/oauth/token");
  assert.deepEqual(sent.init.headers, {
    "Content-Type": "application/x-www-form-urlencoded",
    "x-pelaris-client-ip": "203.0.113.7",
    "x-pelaris-gateway-secret": SECRET,
  });
  assert.equal(sent.init.body, "grant_type=authorization_code&code=fixture-code");
});

test("/token with no usable secret forwards no address headers at all", async () => {
  for (const secret of [undefined, "", "too-short"]) {
    const h = await start({ secret });
    await postForm(h, "/token", { grant_type: "refresh_token", refresh_token: "fixture" });
    assert.deepEqual(h.fetches[0].init.headers, { "Content-Type": "application/x-www-form-urlencoded" }, String(secret));
  }
});

test("/token passes the function's status and body through, and a function that cannot be reached is a 502", async () => {
  const refusing = await start({ upstream: async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } }) });
  const res = await postForm(refusing, "/token", { grant_type: "authorization_code", code: "x" });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid_grant" });
  const down = await start({ upstream: async () => { throw new Error("connect ECONNREFUSED"); } });
  const bad = await postForm(down, "/token", { grant_type: "authorization_code", code: "x" });
  assert.equal(bad.status, 502);
  assert.equal((await bad.json() as { error: string }).error, "proxy_error");
});

test("/token with a JSON body is forwarded as JSON (the fallback)", async () => {
  const h = await start({ secret: SECRET });
  await fetch(`${h.base}/token`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: "fixture" }),
  });
  assert.equal((h.fetches[0].init.headers as Record<string, string>)["Content-Type"], "application/json");
  assert.equal(h.fetches[0].init.body, JSON.stringify({ grant_type: "refresh_token", refresh_token: "fixture" }));
});

test("/revoke goes to the function's revoke endpoint with the same header rules", async () => {
  const h = await start({ secret: SECRET });
  const res = await postForm(h, "/revoke", { token: "fixture-token" }, { "x-pelaris-client-ip": "192.0.2.66" });
  assert.equal(res.status, 200);
  assert.equal(h.fetches[0].url, "https://oauth.example.test/fn/oauth/revoke");
  assert.equal((h.fetches[0].init.headers as Record<string, string>)["x-pelaris-client-ip"], "203.0.113.7");
});

// ── /mcp: the return step (CR-10, CR-15) ────────────────────────────────────

const RESTED = {
  active_queues: [{ queue_id: "q_rest", is_active: false, pause_reason: "inactive_21_days", methodology_id: "ai_gen" }],
  last_connector_use_at: Date.now(),
};
const DIRECT_CALL = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_active_program" } };

function stepDeps(h: { bridgeCalls: Array<{ tool: string; profileId: string }>; logs: Array<Record<string, unknown>> }, bridge?: BridgeCall) {
  return {
    loadDials: async () => DEFAULT_GATEWAY_DIALS,
    bridge: bridge ?? (async (tool: string, profileId: string) => {
      h.bridgeCalls.push({ tool, profileId });
      return { ok: true, result: { resumed_queue_ids: [] } };
    }),
    log: (line: Record<string, unknown>) => h.logs.push(line),
  };
}

function mcpRequest(overrides: Record<string, unknown>): never {
  return { body: DIRECT_CALL, ...overrides } as never;
}

test("the return step runs B1R's return_check once for a direct tool on a connector-authorised rested profile", async () => {
  __resetReturnHookCacheForTest();
  const h = await start();
  await runConnectorReturnStep(
    mcpRequest({ connectorAccess: { profileId: "profile_fixture_0001", profileData: RESTED } }),
    stepDeps(h),
  );
  assert.deepEqual(h.bridgeCalls, [{ tool: "return_check", profileId: "profile_fixture_0001" }]);
});

test("the return step does nothing for admin auth, a fail-open read (no connector access) or a non-direct call", async () => {
  __resetReturnHookCacheForTest();
  const h = await start();
  const access = { profileId: "profile_fixture_0002", profileData: RESTED };
  await runConnectorReturnStep(mcpRequest({ isAdminAuth: true, connectorAccess: access }), stepDeps(h));
  await runConnectorReturnStep(mcpRequest({}), stepDeps(h));
  await runConnectorReturnStep(mcpRequest({ connectorAccess: access, body: { jsonrpc: "2.0", id: 2, method: "tools/list" } }), stepDeps(h));
  await runConnectorReturnStep(mcpRequest({ connectorAccess: access, body: { ...DIRECT_CALL, params: { name: "log_workout" } } }), stepDeps(h));
  assert.deepEqual(h.bridgeCalls, []);
});

test("the return step never throws: a malformed bridge reply, a throwing bridge or a failing dial read still lets the tool run", async () => {
  const access = { profileId: "profile_fixture_0003", profileData: RESTED };
  for (const bridge of [
    (async () => null) as unknown as BridgeCall,
    (async () => { throw new Error("fetch failed"); }) as unknown as BridgeCall,
  ]) {
    __resetReturnHookCacheForTest();
    const h = await start();
    await runConnectorReturnStep(mcpRequest({ connectorAccess: access }), stepDeps(h, bridge));
  }
  __resetReturnHookCacheForTest();
  const h = await start();
  const deps = { ...stepDeps(h), loadDials: async () => { throw new Error("dials down"); } };
  await runConnectorReturnStep(mcpRequest({ connectorAccess: access }), deps);
  assert.deepEqual(h.logs.filter((l) => l.event === "gateway_return_check_error"), [{ severity: "WARNING", event: "gateway_return_check_error" }]);
});

// ── index.ts is wired to these routes (CR-15) ───────────────────────────────

test("index.ts mounts the connector routes, owns no /register, /token or /revoke itself, and awaits the return step inside its try", () => {
  const index = readFileSync(new URL("../../../src/index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(index, /mountConnectorRoutes\(app\);/);
  for (const path of ["/register", "/token", "/revoke"]) {
    assert.doesNotMatch(index, new RegExp(`app\\.post\\("${path}"`), `${path} lives in connector/routes.ts`);
  }
  // MCP_FIXES.md 1.6: auth and the limiter stay first, now wrapped to time each step.
  assert.match(index, /app\.post\("\/mcp", timedStep\("auth", verifyBearerToken\), timedStep\("rate_limit", rateLimiter\),/);
  const tryAt = index.indexOf("  try {\n    // B2a C6 (h), CR-10");
  assert.ok(tryAt > 0, "the return step sits at the top of the handler's try");
  assert.ok(index.indexOf("await runConnectorReturnStep(req);", tryAt) > tryAt);
});
