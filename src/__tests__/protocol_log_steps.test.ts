/**
 * Where a /mcp request's time goes (MCP_FIXES.md §1.6, node:test): the `mcp_request` line carries
 * `latencyMs` (the existing key) and `stepLatencyMs` for auth, rate limit, return check and tool,
 * through a real Express app mounted as index.ts mounts it. Plus the reuse audit: one
 * client-string cleaner for the registrar and the log. Synthetic values only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

import { normaliseClientString } from "../client_string.js";
import { normaliseClientName } from "../connector/dcr_guard.js";
import { addStepLatency, describeMcpRequest, logToolCall, runWithMcpRequestId } from "../logger.js";
import { mcpProtocolLog, mcpRequestIdFor, mcpStepsFor, timedStep } from "../middleware/protocol_log.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function captureLines(): { lines: Record<string, unknown>[]; restore: () => void } {
  const lines: Record<string, unknown>[] = [];
  const stdout = process.stdout as unknown as { write: (chunk: unknown, ...rest: unknown[]) => boolean };
  const original = stdout.write;
  stdout.write = function (chunk: unknown, ...rest: unknown[]) {
    const text = String(chunk);
    if (text.startsWith("{")) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (parsed.event === "mcp_request" || typeof parsed.tool === "string") {
          lines.push(parsed);
          return true;
        }
      } catch {
        // not ours
      }
    }
    return original.call(process.stdout, chunk, ...rest);
  };
  return { lines, restore: () => { stdout.write = original; } };
}

async function serve(app: express.Express, run: (base: string) => Promise<void>): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("the mcp_request line times auth, rate limit, return check and tool, under the existing key names", async () => {
  const app = express();
  app.use(express.json());
  app.use("/mcp", mcpProtocolLog);
  const slowAuth = async (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
    await wait(30);
    next();
  };
  const limiter = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
  app.post("/mcp", timedStep("auth", slowAuth), timedStep("rate_limit", limiter), async (_req, res) => {
    const steps = mcpStepsFor(res);
    await runWithMcpRequestId(mcpRequestIdFor(res), async () => {
      addStepLatency("return_check", 12, steps);
      logToolCall({ requestId: "tool-1", tool: "list_goals", latencyMs: 40, success: true });
    }, steps);
    res.json({ ok: true });
  });
  const cap = captureLines();
  try {
    await serve(app, async (base) => {
      await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }) });
      await wait(50);
    });
  } finally {
    cap.restore();
  }
  const line = cap.lines.find((l) => l.event === "mcp_request");
  assert.ok(line, "one mcp_request line");
  assert.equal(typeof line.latencyMs, "number");
  assert.equal("durationMs" in line, false, "renamed to the existing latencyMs key");
  assert.equal("clientClass" in line, false, "renamed to the existing client_class key");
  const steps = line.stepLatencyMs as Record<string, number>;
  assert.ok(steps.auth >= 25, `auth ${steps.auth}`);
  assert.equal(typeof steps.rate_limit, "number");
  assert.equal(steps.return_check, 12);
  assert.equal(steps.tool, 40);
});

test("a middleware that answers itself (a 401) records no step; the line still has latencyMs", async () => {
  const app = express();
  app.use(express.json());
  app.use("/mcp", mcpProtocolLog);
  app.post("/mcp", timedStep("auth", (_req, res) => { res.status(401).json({ error: "invalid_token" }); }), (_req, res) => { res.json({}); });
  const cap = captureLines();
  try {
    await serve(app, async (base) => {
      const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(r.status, 401);
      await wait(50);
    });
  } finally {
    cap.restore();
  }
  const line = cap.lines.find((l) => l.event === "mcp_request");
  assert.equal(line?.status, 401);
  assert.equal(typeof line?.latencyMs, "number");
  assert.equal(line && "stepLatencyMs" in line, false);
});

test("a step that throws or rejects reaches Express's error handler, never hangs", async () => {
  const app = express();
  app.use(express.json());
  app.use("/mcp", mcpProtocolLog);
  app.post("/mcp", timedStep("auth", async () => { throw new Error("boom"); }), (_req, res) => { res.json({}); });
  await serve(app, async (base) => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 500);
  });
});

test("reuse audit: one client-string cleaner for the registrar (64) and the protocol log (120)", () => {
  const raw = "Pel" + String.fromCharCode(0x202e) + "aris" + String.fromCharCode(0x2028) + "x".repeat(300);
  assert.equal(normaliseClientName(raw), normaliseClientString(raw, 64));
  const d = describeMcpRequest(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: raw } } },
    {},
    SUPPORTED_PROTOCOL_VERSIONS,
    LATEST_PROTOCOL_VERSION,
  );
  assert.equal(d.clientName, normaliseClientString(raw, 120));
});
