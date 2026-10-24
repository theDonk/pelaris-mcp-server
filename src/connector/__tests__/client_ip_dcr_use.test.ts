/**
 * B2a C6 (a, b, d, f): the client address and its forwarding headers, the
 * DCR guard's closed line and alert, `connector_use`, and the onboarding
 * hints (node:test). Synthetic values only (TEST-NET addresses).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  CLIENT_IP_HEADER,
  describeHopShape,
  forwardedIpHeaders,
  gatewayClientIp,
  GATEWAY_SECRET_HEADER,
} from "../client_ip.js";
import {
  __resetDcrRefusedAlertForTest,
  DCR_REFUSED_LINE_KEYS,
  dcrRefusedAlertDocId,
  dcrRefusedLine,
  normaliseClientName,
  raiseConnectorDcrRefusedAlertOnce,
} from "../dcr_guard.js";
import { connectorUseLine, currentConnectorFacts, noteConnectorToolSuccess, runWithConnectorFacts } from "../connector_use.js";
import { onboardingNextStep, preferredUnitsOf } from "../../tools/user/get_onboarding_status.js";

const SECRET = "local-test-oauth-ip-header-0123456789abcdef";

// ── client address (C6 a, b) ────────────────────────────────────────────────

test("the gateway's address: the dial's hop when it is an address, else req.ip, else null", () => {
  const req = { headers: { "x-forwarded-for": "203.0.113.7, 198.51.100.9" }, ip: "10.0.0.1" };
  assert.equal(gatewayClientIp(req, "first"), "203.0.113.7");
  assert.equal(gatewayClientIp(req, "right_most"), "198.51.100.9");
  assert.equal(gatewayClientIp({ headers: { "x-forwarded-for": "1.2.3.4/x" }, ip: "10.0.0.1" }, "first"), "10.0.0.1");
  assert.equal(gatewayClientIp({ headers: {}, ip: "garbage" }, "first"), null);
});

test("forwarding headers: only with a secret of 32 bytes or more and a valid address", () => {
  const req = { headers: { "x-forwarded-for": "203.0.113.7" }, ip: "10.0.0.1" };
  assert.deepEqual(forwardedIpHeaders(req, { secret: SECRET, hop: "first" }), {
    [CLIENT_IP_HEADER]: "203.0.113.7",
    [GATEWAY_SECRET_HEADER]: SECRET,
  });
  assert.deepEqual(forwardedIpHeaders(req, { secret: "", hop: "first" }), {});
  assert.deepEqual(forwardedIpHeaders(req, { secret: undefined, hop: "first" }), {});
  assert.deepEqual(forwardedIpHeaders(req, { secret: "s".repeat(31), hop: "first" }), {});
  assert.deepEqual(forwardedIpHeaders({ headers: { "x-forwarded-for": "nope" } }, { secret: SECRET, hop: "first" }), {});
});

test("an inbound copy of the gateway headers never becomes the forwarded address", () => {
  const req = {
    headers: { [CLIENT_IP_HEADER]: "192.0.2.66", [GATEWAY_SECRET_HEADER]: SECRET, "x-forwarded-for": "203.0.113.7" },
    ip: "10.0.0.1",
  };
  assert.equal(forwardedIpHeaders(req, { secret: SECRET, hop: "first" })[CLIENT_IP_HEADER], "203.0.113.7");
  assert.equal(describeHopShape(req).inbound_gateway_headers, true);
});

test("the hop shape carries counts and families, never an address", () => {
  const shape = describeHopShape({ headers: { "x-forwarded-for": "203.0.113.7, junk, 2001:db8::1" }, ip: "2001:db8::1" });
  assert.deepEqual(shape, { hops: 3, families: [4, 0, 6], req_ip_matches: "right_most", req_ip_family: 6, inbound_gateway_headers: false });
  assert.doesNotMatch(JSON.stringify(shape), /203\.0\.113|2001:db8/);
});

// ── DCR guard (C6 a) ────────────────────────────────────────────────────────

beforeEach(() => __resetDcrRefusedAlertForTest());

test("the closed dcr_refused line has the shared keys, registrar gateway, never the URI", () => {
  const line = dcrRefusedLine({ reason: "custom_scheme_not_listed", scheme: "chatgptapp:", refusedUri: "chatgptapp://chatgpt.com/cb?secret=1" });
  assert.deepEqual(Object.keys(line), [...DCR_REFUSED_LINE_KEYS]);
  assert.deepEqual(line, { event: "dcr_refused", registrar: "gateway", reason: "custom_scheme_not_listed", scheme: "chatgptapp:", assistant_host: true });
  assert.doesNotMatch(JSON.stringify(line), /secret/);
  assert.equal(dcrRefusedLine({ reason: "refused_scheme", scheme: "Weird Scheme:", refusedUri: "x" }).scheme, "other");
  assert.equal(dcrRefusedLine({ reason: "too_many", scheme: null, refusedUri: undefined }).assistant_host, false);
  // C9's host map (lane A added chat.openai.com, A1).
  assert.equal(dcrRefusedLine({ reason: "http_not_loopback", scheme: "http:", refusedUri: "http://chat.openai.com/cb" }).assistant_host, true);
});

function fakeDb() {
  const docs = new Map<string, Record<string, unknown>>();
  return {
    docs,
    collection: (name: string) => ({
      doc: (id: string) => ({
        create: async (data: Record<string, unknown>) => {
          const key = `${name}/${id}`;
          if (docs.has(key)) throw Object.assign(new Error("exists"), { code: 6 });
          docs.set(key, data);
        },
      }),
    }),
  };
}

test("an assistant-host refusal raises the shared alert doc once a day; others write nothing", async () => {
  const now = new Date("2026-10-20T06:00:00Z");
  const db = fakeDb();
  const line = dcrRefusedLine({ reason: "http_not_loopback", scheme: "http:", refusedUri: "http://chatgpt.com/cb" });
  assert.equal(await raiseConnectorDcrRefusedAlertOnce(db as never, line, now), true);
  assert.equal(await raiseConnectorDcrRefusedAlertOnce(db as never, line, now), false);
  assert.equal(dcrRefusedAlertDocId(now), "connector_dcr_refused_2026-10-20");
  const alert = db.docs.get("admin_alerts/connector_dcr_refused_2026-10-20")!;
  assert.equal(alert.severity, "warn");
  assert.equal(alert.category, "connector_dcr_refused");
  assert.deepEqual(Object.keys(alert.details as object).sort(), ["note", "reason", "registrar", "scheme"]);
  __resetDcrRefusedAlertForTest();
  const quiet = fakeDb();
  const plain = dcrRefusedLine({ reason: "refused_scheme", scheme: "javascript:", refusedUri: "javascript://localhost/x" });
  assert.equal(await raiseConnectorDcrRefusedAlertOnce(quiet as never, plain, now), false);
  assert.equal(quiet.docs.size, 0);
});

test("the function's alert today means no second doc (ALREADY_EXISTS)", async () => {
  const now = new Date("2026-10-20T06:00:00Z");
  const db = fakeDb();
  db.docs.set("admin_alerts/connector_dcr_refused_2026-10-20", { category: "connector_dcr_refused" });
  const line = dcrRefusedLine({ reason: "http_not_loopback", scheme: "http:", refusedUri: "http://claude.ai/cb" });
  assert.equal(await raiseConnectorDcrRefusedAlertOnce(db as never, line, now), false);
});

test("the registrant name is normalised as lane A's (controls, bidi and separators out, capped at 64)", () => {
  assert.equal(normaliseClientName("  Pelaris \u202eOfficial\u200b  App\n"), "Pelaris Official App");
  assert.equal(normaliseClientName("x".repeat(80))?.length, 64);
  assert.equal(normaliseClientName("\u200b\u200e"), null);
  assert.equal(normaliseClientName(42), null);
});

// ── connector_use (C6 d) ────────────────────────────────────────────────────

test("connector_use: one closed line per successful tool call under OAuth facts, none without", () => {
  const lines: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { lines.push(s); return true; };
  try {
    noteConnectorToolSuccess();
    runWithConnectorFacts({ profileId: "uid_gw_use_0001", clientClass: "chatgpt" }, () => {
      assert.equal(currentConnectorFacts()?.clientClass, "chatgpt");
      noteConnectorToolSuccess(new Date("2026-10-20T06:00:00Z"));
    });
    runWithConnectorFacts(null, () => noteConnectorToolSuccess());
  } finally {
    (process.stdout as unknown as { write: typeof write }).write = write;
  }
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { severity: "INFO", event: "connector_use", profileId: "uid_gw_use_0001", client_class: "chatgpt", day: "2026-10-20" });
  assert.deepEqual(Object.keys(connectorUseLine({ profileId: "p", clientClass: "unknown" })), ["severity", "event", "profileId", "client_class", "day"]);
});

// ── onboarding hints (C6 f) ─────────────────────────────────────────────────

test("next_step names the tool that moves the person forward", () => {
  assert.equal(onboardingNextStep({ hasCompletedOnboarding: false, hasProgram: false }), "complete_intake");
  assert.equal(onboardingNextStep({ hasCompletedOnboarding: true, hasProgram: false }), "generate_program");
  assert.equal(onboardingNextStep({ hasCompletedOnboarding: true, hasProgram: true }), "train_today");
  assert.equal(onboardingNextStep({ hasCompletedOnboarding: false, hasProgram: true }), "train_today");
});

test("preferred_units reads either field the app writes, closed set only", () => {
  assert.equal(preferredUnitsOf({ preferredUnits: "imperial" }), "imperial");
  assert.equal(preferredUnitsOf({ preferences: { preferred_units: "metric" } }), "metric");
  assert.equal(preferredUnitsOf({ preferredUnits: "stone" }), null);
  assert.equal(preferredUnitsOf({}), null);
});
