/**
 * Generic raw-body webhook proxy tests (`POST /webhooks/:provider`, node:test):
 * covers provider slug/allowlist validation, env-driven target resolution,
 * raw-body byte preservation for HMAC verification, middleware ordering
 * relative to `express.json()`, header/query forwarding, upstream status/error
 * handling, and `src/index.ts` wiring. Synthetic values only.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import express from "express";

import { CLIENT_IP_HEADER, GATEWAY_SECRET_HEADER } from "../../connector/client_ip.js";
import type { LogEntry } from "../../logger.js";
import { corsMiddleware } from "../../middleware/cors.js";
import {
  DEFAULT_ALLOWED_WEBHOOK_PROVIDERS,
  DEFAULT_PROXY_TIMEOUT_MS,
  buildOutboundHeaders,
  buildUpstreamUrl,
  mountWebhookRoutes,
  normalizeProviderSlug,
  parseAllowedProviders,
  parseWebhookTargetsMap,
  providerEnvKey,
  resolveTimeoutMs,
  resolveWebhookTarget,
  type WebhookProxyDeps,
} from "../proxy.js";

// ── Test Servers & Harness ──────────────────────────────────────────────────

interface RecordedUpstreamRequest {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  rawBody: Buffer;
}

interface UpstreamStub {
  url: string;
  requests: RecordedUpstreamRequest[];
  close(): Promise<void>;
}

async function startUpstreamServer(
  respond: (req: RecordedUpstreamRequest, res: http.ServerResponse) => void = (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("OK");
  },
): Promise<UpstreamStub> {
  const requests: RecordedUpstreamRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded: RecordedUpstreamRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        rawBody: Buffer.concat(chunks),
      };
      requests.push(recorded);
      respond(recorded, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface GatewayHarness {
  base: string;
  logs: LogEntry[];
  fetches: Array<{ url: string; init: RequestInit }>;
  close(): Promise<void>;
}

async function startGateway(options: {
  env?: Record<string, string | undefined>;
  allowedProviders?: Iterable<string>;
  maxBodyBytes?: number | string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  mountJsonBeforeWebhook?: boolean;
  includeCors?: boolean;
} = {}): Promise<GatewayHarness> {
  const logs: LogEntry[] = [];
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  const deps: WebhookProxyDeps = {
    env: () => options.env ?? {},
    allowedProviders: options.allowedProviders,
    maxBodyBytes: options.maxBodyBytes,
    timeoutMs: options.timeoutMs,
    log: (entry) => logs.push(entry),
    fetch: (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
      fetches.push({ url: String(input), init: init ?? {} });
      if (options.fetchImpl) return options.fetchImpl(input, init);
      return fetch(input, init);
    }) as typeof fetch,
  };

  const app = express();
  if (options.includeCors) app.use(corsMiddleware);
  if (options.mountJsonBeforeWebhook) {
    app.use(express.json());
  }
  mountWebhookRoutes(app, deps);
  if (!options.mountJsonBeforeWebhook) {
    app.use(express.json());
  }
  app.post("/json-echo", (req, res) => {
    res.json({ isBuffer: Buffer.isBuffer(req.body), body: req.body });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    logs,
    fetches,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const cleanups: Array<() => Promise<void>> = [];
function track<T extends { close(): Promise<void> }>(resource: T): T {
  cleanups.push(() => resource.close());
  return resource;
}

after(async () => {
  await Promise.all(cleanups.map((fn) => fn()));
});

// ── Unit tests: slug, allowlist, target resolution, URL and header helpers ──

test("normalizeProviderSlug accepts valid slugs and rejects traversal or invalid syntax", () => {
  assert.equal(normalizeProviderSlug("wahoo"), "wahoo");
  assert.equal(normalizeProviderSlug("  Provider-A_1 "), "provider-a_1");
  for (const bad of ["", "   ", "-leading", "_leading", "../wahoo", "a/b", "a.b", "bad!", "a".repeat(65), null, 42]) {
    assert.equal(normalizeProviderSlug(bad), null, String(bad));
  }
});

test("parseAllowedProviders defaults to wahoo, parses CSV, and fails closed on empty string", () => {
  assert.deepEqual([...parseAllowedProviders(undefined)], [...DEFAULT_ALLOWED_WEBHOOK_PROVIDERS]);
  assert.deepEqual([...parseAllowedProviders("provider-a, Provider_B , ../bad")], ["provider-a", "provider_b"]);
  assert.deepEqual([...parseAllowedProviders("")], []);
  assert.deepEqual([...parseAllowedProviders("   ")], []);
});

test("providerEnvKey maps provider slugs to uppercase underscore env keys", () => {
  assert.equal(providerEnvKey("wahoo"), "WEBHOOK_TARGET_WAHOO");
  assert.equal(providerEnvKey("provider-a"), "WEBHOOK_TARGET_PROVIDER_A");
});

test("parseWebhookTargetsMap ignores invalid JSON without throwing", () => {
  let invalidCalls = 0;
  assert.equal(parseWebhookTargetsMap(undefined, () => { invalidCalls++; }).size, 0);
  assert.equal(parseWebhookTargetsMap("{not-json", () => { invalidCalls++; }).size, 0);
  assert.equal(parseWebhookTargetsMap('["array"]', () => { invalidCalls++; }).size, 0);
  assert.equal(invalidCalls, 2);

  const valid = parseWebhookTargetsMap('{"Provider-A":" https://example.test/a ","bad!":"https://example.test/b"}');
  assert.equal(valid.get("provider-a"), "https://example.test/a");
  assert.equal(valid.has("bad!"), false);
});

test("resolveWebhookTarget resolves env var, JSON map precedence, and rejects unsafe URLs", () => {
  const fromDirect = resolveWebhookTarget("provider-a", {
    WEBHOOK_TARGET_PROVIDER_A: "https://direct.example.test/hook",
    WEBHOOK_TARGETS: JSON.stringify({ "provider-a": "https://map.example.test/hook" }),
  });
  assert.equal(fromDirect.ok, true);
  if (fromDirect.ok) assert.equal(fromDirect.url.toString(), "https://direct.example.test/hook");

  const fromMap = resolveWebhookTarget("provider-b", {
    WEBHOOK_TARGETS: JSON.stringify({ "provider-b": "https://map.example.test/b" }),
  });
  assert.equal(fromMap.ok, true);
  if (fromMap.ok) assert.equal(fromMap.url.toString(), "https://map.example.test/b");

  assert.deepEqual(resolveWebhookTarget("wahoo", {}), { ok: false, reason: "missing_target" });

  for (const unsafe of ["not-a-url", "file:///etc/passwd", "ftp://example.test/hook", "https://user:pass@example.test/hook"]) {
    assert.deepEqual(
      resolveWebhookTarget("wahoo", { WEBHOOK_TARGET_WAHOO: unsafe }),
      { ok: false, reason: "invalid_target" },
      unsafe,
    );
  }
});

test("resolveTimeoutMs clamps configured values and falls back on invalid inputs", () => {
  assert.equal(resolveTimeoutMs(undefined), DEFAULT_PROXY_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs("abc"), DEFAULT_PROXY_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs("-10"), DEFAULT_PROXY_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs("100"), 1_000);
  assert.equal(resolveTimeoutMs("999999"), 60_000);
  assert.equal(resolveTimeoutMs("8500"), 8_500);
});

test("buildUpstreamUrl preserves raw query strings without allowing caller overwrite of target params", () => {
  const plainTarget = new URL("https://upstream.example.test/hook");
  assert.equal(buildUpstreamUrl(plainTarget, "/webhooks/wahoo"), "https://upstream.example.test/hook");
  assert.equal(
    buildUpstreamUrl(plainTarget, "/webhooks/wahoo?token=abc%201&tag=x"),
    "https://upstream.example.test/hook?token=abc%201&tag=x",
  );

  const paramTarget = new URL("https://upstream.example.test/hook?channel=prod");
  assert.equal(
    buildUpstreamUrl(paramTarget, "/webhooks/wahoo?channel=spoofed&tag=a&tag=b"),
    "https://upstream.example.test/hook?channel=prod&tag=a&tag=b",
  );
});

test("buildOutboundHeaders keeps provider headers and strips hop-by-hop, framing, and gateway trust headers", () => {
  const out = buildOutboundHeaders({
    host: "api.example.test",
    connection: "keep-alive, x-custom-hop",
    "keep-alive": "timeout=5",
    "x-custom-hop": "drop-me",
    "content-length": "123",
    "content-encoding": "gzip",
    expect: "100-continue",
    cookie: "session=abc",
    forwarded: "for=203.0.113.1",
    "x-forwarded-for": "203.0.113.1",
    "x-forwarded-host": "api.example.test",
    "x-forwarded-proto": "https",
    "x-real-ip": "203.0.113.1",
    [CLIENT_IP_HEADER]: "192.0.2.50",
    [GATEWAY_SECRET_HEADER]: "spoofed-secret",
    "content-type": "application/json",
    "x-webhook-signature": "sha256=abcdef",
    "x-provider-token": ["tok-1", "tok-2"],
    authorization: "Bearer webhook-auth",
  });
  assert.deepEqual(out, {
    "content-type": "application/json",
    "x-webhook-signature": "sha256=abcdef",
    "x-provider-token": "tok-1, tok-2",
    authorization: "Bearer webhook-auth",
  });
});

// ── Integration tests: raw-body preservation, middleware order, error handling ──

test("raw-body preservation: non-canonical JSON bytes and HMAC-SHA256 signature reach upstream intact", async () => {
  const upstream = track(await startUpstreamServer((req, res) => {
    const hmac = crypto.createHmac("sha256", "fixture-hmac-secret").update(req.rawBody).digest("hex");
    if (req.headers["x-signature"] !== `sha256=${hmac}`) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("Signature mismatch");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ verified: true, bytes: req.rawBody.byteLength }));
  }));

  const gw = track(await startGateway({
    includeCors: true,
    env: { WEBHOOK_TARGET_WAHOO: upstream.url },
  }));

  // Formatting, key order, \u00e9 escape, 1.00 float, and trailing newline would all change under JSON.parse + JSON.stringify.
  const rawPayload = '{\n  "z": 1,   "a": "caf\\u00e9",  "amount": 1.00 }\n';
  const rawBuffer = Buffer.from(rawPayload, "utf8");
  assert.notEqual(JSON.stringify(JSON.parse(rawPayload)), rawPayload);
  const sig = crypto.createHmac("sha256", "fixture-hmac-secret").update(rawBuffer).digest("hex");

  const res = await fetch(`${gw.base}/webhooks/wahoo?delivery=42`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature": `sha256=${sig}`,
      "x-provider-token": "fixture-webhook-token",
      [CLIENT_IP_HEADER]: "192.0.2.9",
      [GATEWAY_SECRET_HEADER]: "forged",
    },
    body: rawBuffer,
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { verified: true, bytes: rawBuffer.byteLength });
  assert.equal(upstream.requests.length, 1);
  assert.equal(upstream.requests[0].url, "/hook?delivery=42");
  assert.equal(Buffer.compare(upstream.requests[0].rawBody, rawBuffer), 0);
  assert.equal(upstream.requests[0].headers["x-provider-token"], "fixture-webhook-token");
  assert.equal(upstream.requests[0].headers[CLIENT_IP_HEADER], undefined);
  assert.equal(upstream.requests[0].headers[GATEWAY_SECRET_HEADER], undefined);

  // express.json() still parses non-webhook routes normally on the same Express app.
  const echoRes = await fetch(`${gw.base}/json-echo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: true }),
  });
  assert.equal(echoRes.status, 200);
  assert.deepEqual(await echoRes.json(), { isBuffer: false, body: { ok: true } });
});

test("raw-body handling preserves malformed JSON, form payloads, missing Content-Type, and empty bodies", async () => {
  const upstream = track(await startUpstreamServer());
  const gw = track(await startGateway({
    env: { WEBHOOK_TARGET_WAHOO: upstream.url },
  }));

  // 1. Malformed JSON with application/json header is NOT rejected by express.json().
  const malformed = Buffer.from("{not-valid-json");
  const r1 = await fetch(`${gw.base}/webhooks/wahoo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: malformed,
  });
  assert.equal(r1.status, 200);
  assert.equal(Buffer.compare(upstream.requests[0].rawBody, malformed), 0);

  // 2. Form-urlencoded payload arrives verbatim.
  const form = Buffer.from("event=workout_summary&id=99");
  const r2 = await fetch(`${gw.base}/webhooks/wahoo`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  assert.equal(r2.status, 200);
  assert.equal(Buffer.compare(upstream.requests[1].rawBody, form), 0);
  assert.equal(upstream.requests[1].headers["content-type"], "application/x-www-form-urlencoded");

  // 3. Binary payload with omitted Content-Type still forwards exact bytes.
  const binary = Buffer.from([0x00, 0x01, 0xfe, 0xff]);
  const r3 = await fetch(`${gw.base}/webhooks/wahoo`, {
    method: "POST",
    body: binary,
  });
  assert.equal(r3.status, 200);
  assert.equal(Buffer.compare(upstream.requests[2].rawBody, binary), 0);

  // 4. Empty body forwards 0 bytes cleanly.
  const r4 = await fetch(`${gw.base}/webhooks/wahoo`, { method: "POST" });
  assert.equal(r4.status, 200);
  assert.equal(upstream.requests[3].rawBody.byteLength, 0);
});

test("gzip-encoded webhook payload is inflated to raw bytes with content-encoding stripped outbound", async () => {
  const upstream = track(await startUpstreamServer());
  const gw = track(await startGateway({
    env: { WEBHOOK_TARGET_WAHOO: upstream.url },
  }));

  const rawJson = Buffer.from('{"event":"test","value":1.0}\n', "utf8");
  const gzipped = zlib.gzipSync(rawJson);

  const res = await fetch(`${gw.base}/webhooks/wahoo`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-encoding": "gzip",
    },
    body: gzipped,
  });
  assert.equal(res.status, 200);
  assert.equal(Buffer.compare(upstream.requests[0].rawBody, rawJson), 0);
  assert.equal(upstream.requests[0].headers["content-encoding"], undefined);
});

test("misordered express.json() before webhook route fails closed with 500 raw_body_unavailable", async () => {
  const upstream = track(await startUpstreamServer());
  const gw = track(await startGateway({
    mountJsonBeforeWebhook: true,
    env: { WEBHOOK_TARGET_WAHOO: upstream.url },
  }));

  const res = await fetch(`${gw.base}/webhooks/wahoo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: "test" }),
  });
  assert.equal(res.status, 500);
  assert.equal((await res.json() as { error: string }).error, "raw_body_unavailable");
  assert.equal(upstream.requests.length, 0);
});

test("provider allowlist and env-driven generic provider routing", async () => {
  const upstreamA = track(await startUpstreamServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ provider: "a" }));
  }));
  const upstreamB = track(await startUpstreamServer((_req, res) => {
    res.writeHead(202, { "content-type": "text/plain" });
    res.end("accepted-b");
  }));

  const gw = track(await startGateway({
    env: {
      WEBHOOK_ALLOWED_PROVIDERS: "provider-a,provider_b",
      WEBHOOK_TARGET_PROVIDER_A: upstreamA.url,
      WEBHOOK_TARGETS: JSON.stringify({ provider_b: upstreamB.url, wahoo: upstreamA.url }),
    },
  }));

  const resA = await fetch(`${gw.base}/webhooks/provider-a`, { method: "POST", body: "{}" });
  assert.equal(resA.status, 200);
  assert.deepEqual(await resA.json(), { provider: "a" });

  const resB = await fetch(`${gw.base}/webhooks/provider_b`, { method: "POST", body: "{}" });
  assert.equal(resB.status, 202);
  assert.equal(await resB.text(), "accepted-b");

  // Default provider is rejected when not in WEBHOOK_ALLOWED_PROVIDERS.
  const resWahoo = await fetch(`${gw.base}/webhooks/wahoo`, { method: "POST", body: "{}" });
  assert.equal(resWahoo.status, 404);
  assert.equal((await resWahoo.json() as { error: string }).error, "unknown_provider");
});

test("provider validation, method guard, config errors, and payload size limit", async () => {
  const upstream = track(await startUpstreamServer());
  const gw = track(await startGateway({
    env: { WEBHOOK_TARGET_WAHOO: upstream.url },
  }));

  // Unknown provider -> 404
  const unknown = await fetch(`${gw.base}/webhooks/unknown-vendor`, { method: "POST", body: "{}" });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json() as { error: string }).error, "unknown_provider");

  // Invalid provider slug -> 404
  const badSlug = await fetch(`${gw.base}/webhooks/bad!slug`, { method: "POST", body: "{}" });
  assert.equal(badSlug.status, 404);
  assert.equal((await badSlug.json() as { error: string }).error, "unknown_provider");

  // Non-POST on allowlisted provider -> 405 with Allow: POST; on unlisted -> 404
  const getAllowed = await fetch(`${gw.base}/webhooks/wahoo`, { method: "GET" });
  assert.equal(getAllowed.status, 405);
  assert.equal(getAllowed.headers.get("allow"), "POST");
  assert.equal((await getAllowed.json() as { error: string }).error, "method_not_allowed");

  const getUnknown = await fetch(`${gw.base}/webhooks/unknown-vendor`, { method: "GET" });
  assert.equal(getUnknown.status, 404);

  // Payload > 1MB -> 413 payload_too_large before reaching upstream
  const tooLarge = Buffer.alloc(1024 * 1024 + 1, 0x61);
  const largeRes = await fetch(`${gw.base}/webhooks/wahoo`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: tooLarge,
  });
  assert.equal(largeRes.status, 413);
  assert.equal((await largeRes.json() as { error: string }).error, "payload_too_large");
  assert.equal(upstream.requests.length, 0);

  // Unconfigured target -> 503
  const unconfigured = track(await startGateway({ env: {} }));
  const missingTarget = await fetch(`${unconfigured.base}/webhooks/wahoo`, { method: "POST", body: "{}" });
  assert.equal(missingTarget.status, 503);
  assert.equal((await missingTarget.json() as { error: string }).error, "webhook_not_configured");
});

test("upstream status passthrough (204, 401, 429), redirect refusal (502), unreachable (502), and timeout (504)", async () => {
  // 204 No Content
  const noContentGw = track(await startGateway({
    env: { WEBHOOK_TARGET_WAHOO: "https://upstream.example.test/hook" },
    fetchImpl: async () => new Response(null, { status: 204 }),
  }));
  const r204 = await fetch(`${noContentGw.base}/webhooks/wahoo`, { method: "POST", body: "{}" });
  assert.equal(r204.status, 204);
  assert.equal(await r204.text(), "");

  // 401 plain text + 429 Retry-After
  const authFailGw = track(await startGateway({
    env: { WEBHOOK_TARGET_WAHOO: "https://upstream.example.test/hook" },
    fetchImpl: async () => new Response("Unauthorized", { status: 401, headers: { "content-type": "text/plain" } }),
  }));
  const r401 = await fetch(`${authFailGw.base}/webhooks/wahoo`, { method: "POST", body: "{}" });
  assert.equal(r401.status, 401);
  assert.equal(await r401.text(), "Unauthorized");

  const rateLimitedGw = track(await startGateway({
    env: { WEBHOOK_TARGET_WAHOO: "https://upstream.example.test/hook" },
    fetchImpl: async () => new Response("Slow down", {
      status: 429,
      headers: { "content-type": "text/plain", "retry-after": "30" },
    }),
  }));
  const r429 = await fetch(`${rateLimitedGw.base}/webhooks/wahoo`, { method: "POST", body: "{}" });
  assert.equal(r429.status, 429);
  assert.equal(r429.headers.get("retry-after"), "30");

  // Unexpected 302 redirect -> 502 proxy_error (redirect: "manual" enforced)
  const redirectGw = track(await startGateway({
    env: { WEBHOOK_TARGET_WAHOO: "https://upstream.example.test/hook" },
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://other.example.test/" } }),
  }));
  const r302 = await fetch(`${redirectGw.base}/webhooks/wahoo`, { method: "POST", body: "{}" });
  assert.equal(r302.status, 502);
  assert.equal(redirectGw.fetches[0].init.redirect, "manual");
  assert.equal((await r302.json() as { error: string }).error, "proxy_error");

  // Connection error -> 502
  const downGw = track(await startGateway({
    env: { WEBHOOK_TARGET_WAHOO: "https://upstream.example.test/hook" },
    fetchImpl: async () => { throw new Error("connect ECONNREFUSED"); },
  }));
  const r502 = await fetch(`${downGw.base}/webhooks/wahoo`, { method: "POST", body: "{}" });
  assert.equal(r502.status, 502);
  assert.equal((await r502.json() as { error: string }).error, "proxy_error");

  // Timeout -> 504
  const slowGw = track(await startGateway({
    env: { WEBHOOK_TARGET_WAHOO: "https://upstream.example.test/hook" },
    timeoutMs: 50,
    fetchImpl: async () => {
      const err = new Error("The operation timed out");
      err.name = "TimeoutError";
      throw err;
    },
  }));
  const r504 = await fetch(`${slowGw.base}/webhooks/wahoo`, { method: "POST", body: "{}" });
  assert.equal(r504.status, 504);
  assert.equal((await r504.json() as { error: string }).error, "upstream_timeout");
});

test("structured logs never leak headers, secrets, query tokens, or request body", async () => {
  const gw = track(await startGateway({
    env: { WEBHOOK_TARGET_WAHOO: "https://upstream.example.test/hook?targetSecret=hidden-target-secret" },
    fetchImpl: async () => new Response("OK", { status: 200, headers: { "content-type": "text/plain" } }),
  }));

  const secretBody = JSON.stringify({ secretToken: "body-secret-xyz", user: 12345 });
  await fetch(`${gw.base}/webhooks/wahoo?querySecret=hidden-query-secret`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-token": "header-secret-abc",
    },
    body: secretBody,
  });

  assert.equal(gw.logs.length, 1);
  const serialized = JSON.stringify(gw.logs[0]);
  assert.equal(gw.logs[0].event, "webhook_proxy");
  assert.equal(gw.logs[0].provider, "wahoo");
  assert.equal(gw.logs[0].outcome, "forwarded");
  assert.equal(gw.logs[0].status, 200);
  for (const leaked of ["body-secret-xyz", "header-secret-abc", "hidden-query-secret", "hidden-target-secret"]) {
    assert.equal(serialized.includes(leaked), false, `log leaked ${leaked}`);
  }
});

test("src/index.ts mounts mountWebhookRoutes(app) strictly BEFORE app.use(express.json())", () => {
  const indexSource = readFileSync(new URL("../../../src/index.ts", import.meta.url), "utf8");
  const mountIdx = indexSource.indexOf("mountWebhookRoutes(app)");
  const jsonIdx = indexSource.indexOf("app.use(express.json())");
  assert.ok(mountIdx > 0, "mountWebhookRoutes(app) is wired in src/index.ts");
  assert.ok(jsonIdx > 0, "app.use(express.json()) is wired in src/index.ts");
  assert.ok(mountIdx < jsonIdx, "mountWebhookRoutes(app) must be mounted BEFORE app.use(express.json())");
});
