/**
 * Protocol-level request log, security review round 2 (node:test): F1 one line on finish OR
 * close with `completed`, F3 the exact spec method set (with an SDK lockstep check), F4
 * clientInfo redaction and the wider character strip, F6 the shared request id.
 * Synthetic values only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import * as sdkTypes from "@modelcontextprotocol/sdk/types.js";

import { MCP_SPEC_METHODS, REDACTED, describeMcpRequest, logToolCall, runWithMcpRequestId } from "../logger.js";
import { mcpProtocolLog, mcpRequestIdFor } from "../middleware/protocol_log.js";

const describe = (body: unknown, headers: Record<string, unknown> = {}) =>
  describeMcpRequest(body, headers, SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION);

const ch = (...codes: number[]) => String.fromCharCode(...codes);

// ─── F3 ───────────────────────────────────────────────────────────────────────

test("F3: the method set is exact; unknown names under a known prefix and case variants are (other)", () => {
  const d = describe([
    { jsonrpc: "2.0", method: "notifications/johnsmith" },
    { jsonrpc: "2.0", id: 1, method: "tools/brad_pelaris_io" },
    { jsonrpc: "2.0", id: 2, method: "Tools/Call" },
    { jsonrpc: "2.0", id: 3, method: "resources/templates/list" },
    { jsonrpc: "2.0", method: "notifications/elicitation/complete" },
  ]);
  assert.deepEqual(d.rpcMethods, ["(other)", "(other)", "(other)", "resources/templates/list", "notifications/elicitation/complete"]);
  assert.ok(!JSON.stringify(d).includes("johnsmith"));
});

test("F3 lockstep: MCP_SPEC_METHODS is exactly the SDK's method unions plus the 2026-07-28 names", () => {
  type Union = { options: { shape: { method: { value: string } } }[] };
  const types = sdkTypes as unknown as Record<string, Union>;
  const sdk = new Set<string>();
  for (const union of ["ClientRequestSchema", "ClientNotificationSchema", "ServerRequestSchema", "ServerNotificationSchema"]) {
    for (const option of types[union].options) sdk.add(option.shape.method.value);
  }
  assert.ok(sdk.size > 20, "the SDK unions were read");
  const missing = [...sdk].filter((m) => !MCP_SPEC_METHODS.has(m));
  assert.deepEqual(missing, [], "the SDK speaks a method the log would call (other): add it to MCP_SPEC_METHODS");
  const extra = [...MCP_SPEC_METHODS].filter((m) => !sdk.has(m)).sort();
  assert.deepEqual(extra, ["server/discover", "subscriptions/listen"], "only the 2026-07-28 names may sit outside the SDK");
});

// ─── F4 ───────────────────────────────────────────────────────────────────────

test("F4: clientInfo holding an @ (full-width too) is redacted whole", () => {
  const init = (name: unknown, version: unknown) =>
    describe({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", clientInfo: { name, version } } });
  const a = init("brad@pelaris.io", "1.0");
  assert.equal(a.clientName, REDACTED);
  assert.equal(a.clientVersion, "1.0");
  const b = init("Gemini", "user" + ch(0xff20) + "example.com");
  assert.equal(b.clientName, "Gemini");
  assert.equal(b.clientVersion, REDACTED);
  assert.ok(!JSON.stringify([a, b]).includes("pelaris.io"));
  assert.ok(!JSON.stringify([a, b]).includes("example.com"));
});

test("F4: C1 controls, line/paragraph separators and bidi marks, overrides and isolates are stripped", () => {
  const nasty =
    "Go" + ch(0x85) + "og" + ch(0x9b) + "le" + ch(0x2028) + ch(0x2029) + ch(0x202e) + "x" +
    ch(0x202a) + ch(0x2066) + ch(0x2069) + ch(0x200f) + ch(0x061c);
  const d = describe(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: nasty, version: ch(0x2067) + "2.0" } } },
    { accept: "application/json" + ch(0x2028) + "text/html" },
  );
  assert.equal(d.clientName, "Googlex");
  assert.equal(d.clientVersion, "2.0");
  assert.equal(d.accept, "application/jsontext/html");
  const onlyMarks = describe({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: ch(0x202e, 0x2066) } } });
  assert.equal(onlyMarks.clientName, undefined, "nothing left after the strip logs nothing");
});

// ─── F1 + F6, through a real Express app mounted as index.ts mounts it ─────────

interface Captured { lines: Record<string, unknown>[]; restore: () => void }

/** Swallows our JSON lines (and keeps them); passes anything else (the test reporter) through. */
function captureStdout(): Captured {
  const lines: Record<string, unknown>[] = [];
  const stdout = process.stdout as unknown as { write: (chunk: unknown, ...rest: unknown[]) => boolean };
  const original = stdout.write;
  stdout.write = function (chunk: unknown, ...rest: unknown[]) {
    const text = String(chunk);
    let ours = false;
    for (const raw of text.split("\n")) {
      if (!raw.trim().startsWith("{")) continue;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed.event === "mcp_request" || parsed.message === "tool_call: list_goals") {
          lines.push(parsed);
          ours = true;
        }
      } catch {
        // not JSON
      }
    }
    return ours ? true : original.call(process.stdout, chunk, ...rest);
  };
  return { lines, restore: () => { stdout.write = original; } };
}

async function withApp(mount: (app: express.Express) => void, run: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use("/mcp", mcpProtocolLog);
  mount(app);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const post = (base: string, body: unknown, signal?: AbortSignal) =>
  fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });

test("F1: a finished request writes exactly one line, completed: true", async () => {
  const cap = captureStdout();
  try {
    await withApp((app) => app.post("/mcp", (_req, res) => { res.status(202).end(); }), async (base) => {
      const r = await post(base, { jsonrpc: "2.0", method: "notifications/initialized" });
      assert.equal(r.status, 202);
      await settle();
    });
  } finally {
    cap.restore();
  }
  const lines = cap.lines.filter((l) => l.event === "mcp_request");
  assert.equal(lines.length, 1, "finish and the later close write one line between them");
  assert.equal(lines[0].completed, true);
  assert.equal(lines[0].status, 202);
  assert.deepEqual(lines[0].rpcMethods, ["notifications/initialized"]);
});

test("F1: a request the client abandons before any reply still writes exactly one line, completed: false", async () => {
  const cap = captureStdout();
  let handlerSawClose!: () => void;
  const closed = new Promise<void>((resolve) => { handlerSawClose = resolve; });
  try {
    await withApp((app) => app.post("/mcp", (_req, res) => { res.on("close", () => handlerSawClose()); }), async (base) => {
      const controller = new AbortController();
      const pending = post(base, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "list_goals" } }, controller.signal);
      await settle();
      controller.abort();
      await assert.rejects(pending);
      await closed;
      await settle();
    });
  } finally {
    cap.restore();
  }
  const lines = cap.lines.filter((l) => l.event === "mcp_request");
  assert.equal(lines.length, 1, "one line: not zero (the old finish-only listener), not two");
  assert.equal(lines[0].completed, false);
  assert.deepEqual(lines[0].rpcMethods, ["tools/call"]);
});

test("F6: the handler's id is the middleware's, and lines written while serving carry it as mcpRequestId", async () => {
  const cap = captureStdout();
  let handlerId = "";
  try {
    await withApp((app) => app.post("/mcp", async (_req, res) => {
      handlerId = mcpRequestIdFor(res);
      await runWithMcpRequestId(handlerId, async () => {
        await Promise.resolve();
        logToolCall({ requestId: "tool-own-id", tool: "list_goals", latencyMs: 1, success: true });
      });
      res.json({ ok: true });
    }), async (base) => {
      await post(base, { jsonrpc: "2.0", id: 1, method: "tools/call" });
      await settle();
    });
  } finally {
    cap.restore();
  }
  const request = cap.lines.find((l) => l.event === "mcp_request");
  const tool = cap.lines.find((l) => l.tool === "list_goals");
  assert.ok(handlerId.length > 0);
  assert.equal(request?.requestId, handlerId);
  assert.equal(tool?.requestId, "tool-own-id", "the tool keeps its own id");
  assert.equal(tool?.mcpRequestId, handlerId, "and joins the request's mcp_request line");
});

test("F6: outside a request, or on a line already keyed by the request id, no mcpRequestId is added", () => {
  const cap = captureStdout();
  try {
    logToolCall({ requestId: "outside", tool: "list_goals", latencyMs: 1, success: true });
    runWithMcpRequestId("same", () => logToolCall({ requestId: "same", tool: "list_goals", latencyMs: 1, success: true }));
  } finally {
    cap.restore();
  }
  assert.equal(cap.lines.length, 2);
  for (const line of cap.lines) assert.equal("mcpRequestId" in line, false);
  assert.ok(mcpRequestIdFor({ locals: {} } as unknown as express.Response).length > 0, "a fresh id when the middleware did not run");
});
