/**
 * get_body_analysis reads the server's core tool over the core bridge, so the connector and the
 * in-app coach report the same weight, height and changes. The bridge is stubbed with a local
 * HTTP server (emulator mode: plain fetch, no ID token). All data is obviously fake.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { McpTokenClaims } from "../../../auth.js";

const capturedRequests: Array<Record<string, unknown>> = [];
let respondWith: Record<string, unknown> = {};

const bridgeStub = http.createServer((req, res) => {
  let data = "";
  req.on("data", (chunk) => {
    data += chunk;
  });
  req.on("end", () => {
    capturedRequests.push(JSON.parse(data) as Record<string, unknown>);
    res.writeHead(200, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify(respondWith));
  });
});
await new Promise<void>((resolve) => bridgeStub.listen(0, "127.0.0.1", resolve));
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.CF_BASE_URL = `http://127.0.0.1:${(bridgeStub.address() as AddressInfo).port}`;

const { bodyAnalysisFromCore, bodyScanHistory, registerGetBodyAnalysis } = await import("../get_body_analysis.js");
const { runWithAuth } = await import("../../../request-context.js");

after(() => {
  bridgeStub.closeAllConnections?.();
  bridgeStub.close();
});

const claims: McpTokenClaims = {
  sub: "pseudonym_test",
  scope: "health:read",
  platform: "test",
  profile_id: "profile_test_1",
  exp: 0,
  iat: 0,
};

type Handler = () => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

function captureHandler(): Handler {
  let handler: Handler | null = null;
  const fakeServer = {
    registerTool: (_name: string, _config: unknown, h: unknown) => {
      handler = h as Handler;
    },
  };
  registerGetBodyAnalysis(fakeServer as unknown as Parameters<typeof registerGetBodyAnalysis>[0]);
  assert.ok(handler);
  return handler;
}

const LINK = "https://example.test/scan";

const scanWithOwnMetrics = {
  analyzedAt: "2026-01-10T08:00:00.000Z",
  source: "photo",
  confidence: 0.8,
  measurements: { weightKg: 80, heightCm: 180, waistCm: 84, bodyFatPercent: 18 },
  latestMeasurements: { weightKg: { value: 80, source: "photo", recordedAt: "2026-01-10T08:00:00.000Z", displayDate: "Sat 10 Jan" } },
  ratios: { waistToHeight: 0.47 },
  archetype: "balanced",
  areasOfFocus: ["core"],
  photoUrls: ["https://example.test/photo.jpg"],
};

test("a scan with its own weight and height reads through unchanged, in the existing shape", () => {
  const out = bodyAnalysisFromCore(scanWithOwnMetrics, LINK);
  const m = out.measurements as Record<string, unknown>;
  assert.equal(m.weightKg, 80);
  assert.equal(m.heightCm, 180);
  assert.equal(m.bodyFatPercent, 18);
  assert.equal(m.chestCm, null, "missing fields stay as null, as before");
  assert.equal(out.source, "photo");
  assert.equal(out.asOf, "2026-01-10");
  assert.equal(out.scanLink, LINK);
  assert.deepEqual(out.ratios, { shoulderToWaist: null, waistToHip: null, waistToHeight: 0.47 });
  assert.equal(out.comparisonToPrevious, null, "one scan: no comparison");
  assert.equal(out.history, null, "one scan: no history");
  assert.deepEqual(
    Object.keys(out).sort(),
    [
      "analyzedAt", "archetype", "areasOfFocus", "asOf", "asOfNote", "assessment", "bodyFatRangePercent",
      "comparisonToPrevious", "confidence", "history", "measurements", "ratios", "scanLink", "source", "symmetry",
      "trainingRecommendation",
    ],
    "only the fields the tool has always returned",
  );
  assert.ok(!JSON.stringify(out).includes("photo.jpg"), "nothing photo-shaped crosses over");
});

test("without scan weight and height, the server's profile fallback reaches the assistant", () => {
  const out = bodyAnalysisFromCore(
    {
      analyzedAt: "2026-02-01T00:00:00.000Z",
      source: "profile",
      measurements: { weightKg: 72.5, heightCm: 170 },
      ratios: {},
      areasOfFocus: [],
    },
    LINK,
  );
  const m = out.measurements as Record<string, unknown>;
  assert.equal(m.weightKg, 72.5);
  assert.equal(m.heightCm, 170);
  assert.equal(out.source, "profile");
  assert.match(String(out.asOfNote), /source: profile/);
});

test("changes since the previous scan keep the server's sign: newer minus older", () => {
  const out = bodyAnalysisFromCore(
    {
      ...scanWithOwnMetrics,
      comparisonToPrevious: {
        previousAnalyzedAt: "2025-12-01T08:00:00.000Z",
        changes: { weightKg: { value: -1.5, direction: "down" }, waistCm: { value: 0.4, direction: "up" }, hipsCm: null },
      },
    },
    LINK,
  );
  const cmp = out.comparisonToPrevious as { previousAnalyzedAt: string; changes: Record<string, unknown> };
  assert.equal(cmp.previousAnalyzedAt, "2025-12-01T08:00:00.000Z");
  assert.deepEqual(cmp.changes.weightKg, { value: -1.5, direction: "down" });
  assert.deepEqual(cmp.changes.waistCm, { value: 0.4, direction: "up" });
  assert.equal(cmp.changes.hipsCm, null);
  assert.equal(cmp.changes.shouldersCm, null);
});

test("scan history passes through as dates and numbers only, newest first", () => {
  const out = bodyAnalysisFromCore(
    {
      ...scanWithOwnMetrics,
      history: [
        { analyzedAt: "2026-01-10T08:00:00.000Z", weightKg: 80, waistCm: 84, hipsCm: 99, shouldersCm: 117, photoPath: "scans/a.jpg", note: "free text" },
        { analyzedAt: "2025-12-01T08:00:00.000Z", waistCm: "85", hipsCm: 100 },
        { analyzedAt: "not a date", waistCm: 86 },
        { analyzedAt: "2025-11-01T08:00:00.000Z", waistCm: Number.NaN, weightKg: -2 },
        "a string",
        null,
      ],
    },
    LINK,
  );
  assert.deepEqual(out.history, [
    { analyzedAt: "2026-01-10T08:00:00.000Z", weightKg: 80, waistCm: 84, hipsCm: 99, shouldersCm: 117 },
    { analyzedAt: "2025-12-01T08:00:00.000Z", hipsCm: 100 },
  ]);
  assert.ok(!JSON.stringify(out.history).includes("jpg"));
});

test("history: not an array, or fewer than two good scans, is null; at most twelve", () => {
  assert.equal(bodyScanHistory(undefined), null);
  assert.equal(bodyScanHistory({ analyzedAt: "2026-01-10" }), null);
  assert.equal(bodyScanHistory([{ analyzedAt: "2026-01-10T00:00:00.000Z", waistCm: 80 }]), null);
  const many = Array.from({ length: 20 }, (_, i) => ({ analyzedAt: `2026-01-${String(20 - i).padStart(2, "0")}T00:00:00.000Z`, waistCm: 80 + i }));
  assert.equal(bodyScanHistory(many)?.length, 12);
});

test("the handler asks the bridge for the core tool with the profile from the claims", async () => {
  const handler = captureHandler();
  respondWith = { ok: true, tool: "get_body_analysis", result: scanWithOwnMetrics };
  capturedRequests.length = 0;
  const reply = await runWithAuth(claims, () => handler());
  assert.equal(reply.isError, undefined);
  assert.deepEqual(capturedRequests[0], { tool: "get_body_analysis", profileId: "profile_test_1", input: {} });
  const body = JSON.parse(reply.content[0].text) as Record<string, unknown>;
  assert.equal((body.measurements as Record<string, unknown>).weightKg, 80);
  assert.ok(!reply.content[0].text.includes("photo.jpg"));
});

test("no data at all keeps the old empty answer with a scan link", async () => {
  const handler = captureHandler();
  respondWith = { ok: true, tool: "get_body_analysis", result: null };
  const reply = await runWithAuth(claims, () => handler());
  const body = JSON.parse(reply.content[0].text) as Record<string, unknown>;
  assert.equal(body.analysis, null);
  assert.equal(body.message, "No body analysis data found");
  assert.equal(typeof body.scanLink, "string");
});

test("a bridge failure is an error, and the scope check runs before the bridge", async () => {
  const handler = captureHandler();
  respondWith = { ok: false, tool: "get_body_analysis", error: "boom" };
  const failed = await runWithAuth(claims, () => handler());
  assert.equal(failed.isError, true);

  capturedRequests.length = 0;
  const denied = await runWithAuth({ ...claims, scope: "training:read" }, () => handler());
  assert.equal(denied.isError, true);
  assert.equal(capturedRequests.length, 0);
});
