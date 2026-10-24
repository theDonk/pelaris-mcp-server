/**
 * B2a C6: the gateway reads the same dials as wayfinder, with the same
 * defaults and bounds; a failed read keeps the last good value (node:test).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  __resetGatewayDialsForTest,
  __setGatewayDialsFetcherForTest,
  DEFAULT_GATEWAY_DIALS,
  DIAL_BOUNDS,
  loadGatewayDials,
  parseGatewayDials,
} from "../dials.js";

test("defaults match wayfinder (dcr_per_hour 10, stamp 60 min, return step 10000 ms, first hop, log only)", () => {
  assert.equal(DEFAULT_GATEWAY_DIALS.dcrPerHour, 10);
  assert.equal(DEFAULT_GATEWAY_DIALS.connectorUseStampMinutes, 60);
  assert.equal(DEFAULT_GATEWAY_DIALS.bridgeReturnStepTimeoutMs, 10000);
  assert.equal(DEFAULT_GATEWAY_DIALS.clientIpHop, "first");
  assert.equal(DEFAULT_GATEWAY_DIALS.createLimitMode, "log_only");
  assert.deepEqual(DIAL_BOUNDS.dcr_per_hour, { fallback: 10, floor: 1, ceiling: 100 });
  assert.deepEqual(DIAL_BOUNDS.connector_use_stamp_minutes, { fallback: 60, floor: 1, ceiling: 1440 });
  assert.deepEqual(DIAL_BOUNDS.bridge_return_step_timeout_ms, { fallback: 10000, floor: 250, ceiling: 30000 });
});

test("values are clamped, closed sets only, anything else keeps the default", () => {
  const dials = parseGatewayDials({
    controls: { dcr_per_hour: 1000, client_ip_hop: "right_most", create_limit_mode: "enforce" },
    redirect: { custom_schemes: ["myapp:", "http:"] },
    jit: { connector_use_stamp_minutes: 0, bridge_return_step_timeout_ms: "fast" },
  });
  assert.equal(dials.dcrPerHour, 100);
  assert.equal(dials.clientIpHop, "right_most");
  assert.equal(dials.createLimitMode, "enforce");
  assert.equal(dials.connectorUseStampMinutes, 1);
  assert.equal(dials.bridgeReturnStepTimeoutMs, 10000);
  assert.deepEqual([...dials.redirectPolicy.customSchemes], ["myapp:"]);
  const odd = parseGatewayDials({ controls: { client_ip_hop: "middle", create_limit_mode: "ENFORCE" } });
  assert.equal(odd.clientIpHop, "first");
  assert.equal(odd.createLimitMode, "log_only");
});

test("reads once a minute and keeps the last good value on a read error", async () => {
  let calls = 0;
  let fail = false;
  __setGatewayDialsFetcherForTest(async (path) => {
    calls++;
    if (fail) throw new Error("unavailable");
    return path === "system/connector_signup_controls" ? { dcr_per_hour: 25 } : null;
  });
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    assert.equal((await loadGatewayDials(1_000_000)).dcrPerHour, 25);
    assert.equal((await loadGatewayDials(1_030_000)).dcrPerHour, 25);
    assert.equal(calls, 3);
    fail = true;
    assert.equal((await loadGatewayDials(1_061_000)).dcrPerHour, 25);
  } finally {
    console.warn = warn;
    __resetGatewayDialsForTest();
  }
});

// B2a fix pass, CR-12: a failed read is cached for the same minute. /token and /revoke read the dials
// before every proxy, so a Firestore brownout used to put three failing reads in front of each call.
test("a failed read is not retried for the same minute: the defaults, or the last good value", async () => {
  let reads = 0;
  let fail = true;
  __setGatewayDialsFetcherForTest(async (path) => {
    reads++;
    if (fail) throw new Error("unavailable");
    return path === "system/connector_signup_controls" ? { dcr_per_hour: 25 } : null;
  });
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    for (const t of [2_000_000, 2_001_000, 2_030_000, 2_059_000]) {
      assert.equal((await loadGatewayDials(t)).dcrPerHour, 10, "the default");
    }
    assert.equal(reads, 3, "one attempt (three docs read in parallel), not one per call");
    fail = false;
    assert.equal((await loadGatewayDials(2_061_000)).dcrPerHour, 25);
    assert.equal(reads, 6);
    // A later failure keeps the good value for its minute too.
    fail = true;
    assert.equal((await loadGatewayDials(2_130_000)).dcrPerHour, 25);
    assert.equal((await loadGatewayDials(2_140_000)).dcrPerHour, 25);
    assert.equal(reads, 9);
  } finally {
    console.warn = warn;
    __resetGatewayDialsForTest();
  }
});
