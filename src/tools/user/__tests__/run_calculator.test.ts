/**
 * Tests for the run_calculator MCP tool (node:test). Run after build.
 *
 * The bridge is stubbed with a local HTTP server (emulator mode: plain fetch,
 * no ID token). Proves: the id enum matches the server catalogue's ids, the
 * bridge input is the id and inputs only, a saved result passes through, and a
 * not-saved result keeps the server's message and gains a link into Pelaris.
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

const {
  CALCULATOR_IDS,
  RUN_CALCULATOR_DESCRIPTION,
  buildRunCalculatorReply,
  registerRunCalculator,
  runCalculatorIdField,
  runCalculatorInputsField,
  toBridgeInput,
} = await import("../run_calculator.js");
const { plainEntryLink } = await import("../../shared/entry_links.js");
const { runWithAuth } = await import("../../../request-context.js");

after(() => {
  bridgeStub.closeAllConnections?.();
  bridgeStub.close();
});

// Copied from the Pelaris server's calculator catalogue (ids only, same order).
const SERVER_CATALOGUE_IDS = [
  "projected_1rm_rir",
  "race_predictor_riegel",
  "vo2max_vdot_friend_hunt",
  "body_ratios_archetype_mapper",
  "concurrent_training_scheduler",
  "return_to_training_ramp",
  "sweat_rate_sodium_fuel",
  "protein_leucine_sleep_anchor",
  "deload_readiness_6signal",
  "plyo_foot_contacts_cns",
  "swim_to_gym_dryland_scaler",
  "team_sport_match_day_microcycle",
  "hyrox_station_split_compromised_run",
  "workout_csv_analyser",
  "training_split_selector",
  "zone2_heart_rate_zones",
  "mas_conditioning_grid",
  "vertical_jump_rsi_power",
  "ffmi_muscular_potential",
  "tape_rfm_body_fat",
];

const claims: McpTokenClaims = {
  sub: "pseudonym_test",
  scope: "training:read",
  platform: "test",
  profile_id: "profile_test_1",
  exp: 0,
  iat: 0,
};

type Handler = (params: { calculatorId: string; inputs?: Record<string, unknown> }) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function capture(): { name: string; annotations: Record<string, unknown>; description: string; handler: Handler } {
  let captured: { name: string; annotations: Record<string, unknown>; description: string; handler: Handler } | null =
    null;
  const fakeServer = {
    registerTool: (name: string, config: Record<string, unknown>, handler: unknown) => {
      captured = {
        name,
        annotations: config.annotations as Record<string, unknown>,
        description: config.description as string,
        handler: handler as Handler,
      };
    },
  };
  registerRunCalculator(fakeServer as unknown as Parameters<typeof registerRunCalculator>[0]);
  assert.ok(captured);
  return captured;
}

test("the id enum has the 20 server catalogue ids, in order", () => {
  assert.equal(CALCULATOR_IDS.length, 20);
  assert.deepEqual([...CALCULATOR_IDS], SERVER_CATALOGUE_IDS);
  assert.deepEqual([...runCalculatorIdField.options], SERVER_CATALOGUE_IDS);
  assert.throws(() => runCalculatorIdField.parse("not_a_calculator"));
});

test("registers with honest annotations and plain copy", () => {
  const tool = capture();
  assert.equal(tool.name, "run_calculator");
  assert.equal(tool.annotations.readOnlyHint, false, "a paid athlete's result is saved");
  assert.equal(tool.annotations.destructiveHint, false);
  assert.equal(tool.annotations.openWorldHint, false);
  assert.equal(tool.description, RUN_CALCULATOR_DESCRIPTION);
  assert.ok(tool.description.includes("free to run"));
  assert.ok(tool.description.includes("Pelaris Ocean and Pelaris Horizon"));
  assert.ok(!tool.description.includes("—"), "no em dashes");
});

test("input mapping: id and inputs only, inputs default to empty", () => {
  assert.deepEqual(runCalculatorInputsField.parse(undefined), {});
  assert.deepEqual(runCalculatorInputsField.parse({ weightKg: 100, sex: "male", repeat: true }), {
    weightKg: 100,
    sex: "male",
    repeat: true,
  });
  assert.throws(() => runCalculatorInputsField.parse({ nested: { a: 1 } }));
  assert.deepEqual(toBridgeInput({ calculatorId: "projected_1rm_rir", inputs: { weightKg: 100, reps: 5 } }), {
    calculatorId: "projected_1rm_rir",
    inputs: { weightKg: 100, reps: 5 },
  });
  assert.deepEqual(toBridgeInput({ calculatorId: "zone2_heart_rate_zones" }), {
    calculatorId: "zone2_heart_rate_zones",
    inputs: {},
  });
  // A connection that may not write health data asks the server for the answer only.
  assert.deepEqual(toBridgeInput({ calculatorId: "zone2_heart_rate_zones" }, false), {
    calculatorId: "zone2_heart_rate_zones",
    inputs: {},
    saveAllowed: false,
  });
});

test("a saved result passes through unchanged", () => {
  const saved = { saved: true, calculatorResult: { summaryText: "Done" } };
  assert.deepEqual(buildRunCalculatorReply(saved, "https://example.test/link"), saved);
});

test("a not-saved result keeps the server's message and gains a link", () => {
  const notSaved = {
    saved: false,
    calculatorResult: { summaryText: "Done" },
    saveDenied: { message: "Saving results is part of Pelaris Ocean and Horizon." },
  };
  const withLink = buildRunCalculatorReply(notSaved, "https://example.test/signed");
  assert.deepEqual(withLink.saveDenied, {
    message: "Saving results is part of Pelaris Ocean and Horizon.",
    link: "https://example.test/signed",
  });
  assert.deepEqual(withLink.calculatorResult, notSaved.calculatorResult);
  const plain = buildRunCalculatorReply(notSaved);
  assert.equal((plain.saveDenied as Record<string, unknown>).link, plainEntryLink("calculators"));
});

test("the handler sends the profile from claims and links a not-saved result", async () => {
  const tool = capture();
  respondWith = {
    ok: true,
    tool: "run_science_calculator",
    result: { saved: false, calculatorResult: { summaryText: "Done" }, saveDenied: { message: "Saving is on paid plans." } },
  };
  const response = await runWithAuth(claims, () =>
    tool.handler({ calculatorId: "zone2_heart_rate_zones", inputs: { age: 40 } }),
  );
  assert.notEqual(response.isError, true);
  const request = capturedRequests.at(-1);
  assert.ok(request);
  assert.equal(request.tool, "run_science_calculator");
  assert.equal(request.profileId, "profile_test_1");
  // These claims are read-only, so the server is asked for the answer without a save.
  assert.deepEqual(request.input, { calculatorId: "zone2_heart_rate_zones", inputs: { age: 40 }, saveAllowed: false });
  const parsed = JSON.parse(response.content[0].text) as { saveDenied: Record<string, unknown> };
  assert.equal(parsed.saveDenied.message, "Saving is on paid plans.");
  assert.ok(String(parsed.saveDenied.link).startsWith(plainEntryLink("calculators")));
});

test("a connection that may write health data lets the server's save rule decide", async () => {
  const tool = capture();
  respondWith = { ok: true, tool: "run_science_calculator", result: { saved: true, calculatorResult: { summaryText: "Done" } } };
  await runWithAuth({ ...claims, scope: "training:read health:write" }, () =>
    tool.handler({ calculatorId: "zone2_heart_rate_zones", inputs: { age: 40 } }),
  );
  assert.deepEqual(capturedRequests.at(-1)?.input, { calculatorId: "zone2_heart_rate_zones", inputs: { age: 40 } });
});

test("denies without training:read, never touching the bridge", async () => {
  const tool = capture();
  const before = capturedRequests.length;
  const denied = await runWithAuth({ ...claims, scope: "training:write" }, () =>
    tool.handler({ calculatorId: "projected_1rm_rir" }),
  );
  assert.equal(denied.isError, true);
  assert.equal(capturedRequests.length, before);
});
