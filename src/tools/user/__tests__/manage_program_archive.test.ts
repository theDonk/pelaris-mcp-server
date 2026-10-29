/**
 * manage_program archive goes through Pelaris's core tool `archive_program` over the core bridge (connector rev 2.1).
 * node:test, no extra dependencies, no Firestore, no external network.
 *
 * The bridge is stubbed two ways: a local HTTP server behind the REAL `callCoreBridge` (emulator mode: plain fetch), which
 * proves the wire contract (tool name, profile id from the token only, the optional program id); and an injected
 * `callBridge` for the thrown-error paths (the production HTTP client throws on a 403). Replies are read through a real
 * McpServer and client over the SDK's in-memory transport.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
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
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:1";
process.env.CF_BASE_URL = `http://127.0.0.1:${(bridgeStub.address() as AddressInfo).port}`;

const { ARCHIVE_SENTENCES, MANAGE_PROGRAM_DESCRIPTION, archiveTryAgain, mapArchiveResult, registerManageProgram, thrownBridgeCodeOf } =
  await import("../manage_program.js");
const { checkWriteRateLimit } = await import("../../../middleware/rate-limiter.js");
const { TEST_CLAIMS, captureLogs, hasDash, openToolSession } = await import("./mcp_harness.js");

after(() => {
  bridgeStub.closeAllConnections?.();
  bridgeStub.close();
});

const LINK_PROGRAM = "https://coach.pelaris.io/start/program";
const LINK_TRAIN = "https://coach.pelaris.io/start/train";

// The core's fixed sentences (functions/src/tools/core/archive_program.ts ARCHIVE_MESSAGES), relayed word for word.
const CORE_MESSAGES = {
  removed: "Removed. You can build a fresh program any time.",
  refund_pending: "Removed, but the last step did not finish just now. Please try again.",
  open_in_app:
    "Pause, Stop and Remove for this program are in the Pelaris app, under Profile. " +
    "Open Pelaris and tap Profile to choose the one you want.",
  already_replaced: "That program was already replaced by a newer one, so nothing needed changing.",
} as const;

const TYPED_ID = "queue_secret_name_20261001_090000";

const ok = (outcome: keyof typeof CORE_MESSAGES) => ({
  ok: true,
  tool: "archive_program",
  result: { outcome, message: CORE_MESSAGES[outcome] },
});
const refused = (error: string, errorDetail?: unknown) => ({ ok: false, tool: "archive_program", error, ...(errorDetail ? { errorDetail } : {}) });

async function archive(args: Record<string, unknown>, deps: Parameters<typeof registerManageProgram>[1], claims: McpTokenClaims | null = TEST_CLAIMS) {
  const session = await openToolSession((server) => registerManageProgram(server, deps));
  try {
    return await captureLogs(() => session.call("manage_program", { action: "archive", ...args }, claims));
  } finally {
    await session.close();
  }
}

const bridgeReturning = (envelope: unknown) => ({ callBridge: async () => envelope as never });

// ── Registration ─────────────────────────────────────────────────────────────

test("registers under the same name, destructive and idempotent, with the same two arguments", async () => {
  const session = await openToolSession((server) => registerManageProgram(server, bridgeReturning({})));
  try {
    const tool = await session.listedTool("manage_program");
    assert.ok(tool, "still listed");
    assert.equal(tool.description, MANAGE_PROGRAM_DESCRIPTION);
    const annotations = tool.annotations as Record<string, unknown>;
    assert.equal(annotations.destructiveHint, true);
    assert.equal(annotations.idempotentHint, true);
    assert.equal(annotations.readOnlyHint, false);
    const properties = (tool.inputSchema as { properties: Record<string, unknown> }).properties;
    assert.deepEqual(Object.keys(properties).sort(), ["action", "programId"]);
    // The honest words: Remove for an unstarted program, the app's Pause, Stop and Remove for the rest.
    for (const word of ["Pause", "Stop", "Remove", "Profile", "programId"]) assert.ok(MANAGE_PROGRAM_DESCRIPTION.includes(word), word);
    assert.equal(MANAGE_PROGRAM_DESCRIPTION.includes("archived"), false);
    assert.equal(hasDash(MANAGE_PROGRAM_DESCRIPTION), false);
  } finally {
    await session.close();
  }
});

// ── The wire: the real bridge client against a local stub ────────────────────

test("the bridge gets archive_program with the profile id from the token only, and the program id when named", async () => {
  respondWith = ok("removed");
  const session = await openToolSession((server) => registerManageProgram(server));
  try {
    const { value } = await captureLogs(async () => ({
      named: await session.call("manage_program", { action: "archive", programId: TYPED_ID, profileId: "someone_else", uid: "other" }),
      unnamed: await session.call("manage_program", { action: "archive" }),
      blank: await session.call("manage_program", { action: "archive", programId: "" }),
    }));
    assert.equal(value.named.isError, false);
    const [named, unnamed, blank] = capturedRequests.slice(-3) as Array<{ tool: string; profileId: string; input: Record<string, unknown> }>;
    assert.equal(named.tool, "archive_program");
    assert.equal(named.profileId, "profile_test_1");
    assert.deepEqual(named.input, { queueId: TYPED_ID });
    assert.equal(unnamed.profileId, "profile_test_1");
    assert.deepEqual(unnamed.input, {});
    assert.deepEqual(blank.input, {}, "an empty id is no id");
  } finally {
    await session.close();
  }
});

// ── Every outcome, word for word ─────────────────────────────────────────────

const OUTCOMES: Array<[keyof typeof CORE_MESSAGES, string | undefined]> = [
  ["removed", LINK_PROGRAM],
  ["refund_pending", undefined],
  ["open_in_app", LINK_TRAIN],
  ["already_replaced", undefined],
];

for (const [outcome, link] of OUTCOMES) {
  test(`outcome ${outcome}: the core's sentence word for word${link ? ` and the ${link.endsWith("train") ? "train" : "program"} link` : ", no link"}`, async () => {
    const { value } = await archive({ programId: TYPED_ID }, bridgeReturning(ok(outcome)));
    assert.equal(value.isError, false);
    const parsed = JSON.parse(value.text) as Record<string, unknown>;
    assert.equal(parsed.status, outcome);
    assert.equal(parsed.message, CORE_MESSAGES[outcome]);
    assert.equal(parsed.link, link);
    // refund_pending alone carries how to retry; every other outcome is just its status, message and (some) a link.
    const expectedKeys = [
      ...(link ? ["link"] : []),
      "message",
      "status",
      ...(outcome === "refund_pending" ? ["how_to_retry"] : []),
    ].sort();
    assert.deepEqual(Object.keys(parsed).sort(), expectedKeys);
  });
}

test("open_in_app names Pause, Stop and Remove in Profile and carries the /start/train link (a started program)", async () => {
  const { value } = await archive({ programId: TYPED_ID }, bridgeReturning(ok("open_in_app")));
  const parsed = JSON.parse(value.text) as { message: string; link: string };
  for (const word of ["Pause", "Stop", "Remove", "Profile"]) assert.ok(parsed.message.includes(word), word);
  assert.equal(parsed.link, LINK_TRAIN);
});

test("refund_pending is not an error, asks the assistant to call again, and says how when no programId was passed", async () => {
  const { value } = await archive({ programId: TYPED_ID }, bridgeReturning(ok("refund_pending")));
  assert.equal(value.isError, false);
  const parsed = JSON.parse(value.text) as { message: string; how_to_retry: string };
  assert.ok(parsed.message.includes("try again"));
  // The removed program is off the running list, so a repeat with no programId finds nothing: the reply says where to get the id.
  assert.equal(
    parsed.how_to_retry,
    "Call manage_program again with the same programId. If you did not pass one, find it with get_program_status (action list_history): it is the program whose status is removed.",
  );
  assert.equal(parsed.how_to_retry.includes(TYPED_ID), false);
  assert.equal(hasDash(parsed.how_to_retry), false);
});

// ── Every refusal: a fixed sentence, never the id or a raw error ─────────────

const REFUSALS: Array<[string, string]> = [
  ["not_found", ARCHIVE_SENTENCES.notFound],
  ["permission_denied", ARCHIVE_SENTENCES.permissionDenied],
  ["missing_required_arg", ARCHIVE_SENTENCES.missingArg],
  ["archive_failed", ARCHIVE_SENTENCES.tryAgain],
  ["tool_not_allowed", ARCHIVE_SENTENCES.tryAgain],
  ["something the core invented later", ARCHIVE_SENTENCES.tryAgain],
];

for (const [code, sentence] of REFUSALS) {
  test(`refusal ${code}: the fixed sentence, an error, nothing echoed`, async () => {
    const { value } = await archive({ programId: TYPED_ID }, bridgeReturning(refused(code)));
    assert.equal(value.isError, true);
    assert.equal(value.text, `Error: ${sentence}`);
    assert.equal(value.text.includes(TYPED_ID), false);
    assert.equal(value.text.includes(code), false, "the code itself is not echoed");
  });
}

test("the fixed sentences are the design's, and carry no em dash", () => {
  assert.equal(ARCHIVE_SENTENCES.notFound, "I could not find that program on your list. Ask to see your programs and I will pick the right one.");
  assert.equal(ARCHIVE_SENTENCES.permissionDenied, "Your account is being deleted, so programs cannot be changed.");
  assert.equal(ARCHIVE_SENTENCES.choose, "You have more than one program. Which one should I set aside?");
  assert.equal(ARCHIVE_SENTENCES.tryAgain, "I could not finish that just now. Please try again in a moment.");
  for (const sentence of Object.values(ARCHIVE_SENTENCES)) assert.equal(hasDash(sentence), false, sentence);
});

test("a raw error text in the envelope is never echoed", async () => {
  const hostile = refused("Error: ENOENT /workspace/profiles/abc123/queues/queue_x with stack at Object.<anonymous>");
  const { value, logs } = await archive({ programId: TYPED_ID }, bridgeReturning(hostile));
  assert.equal(value.text, `Error: ${ARCHIVE_SENTENCES.tryAgain}`);
  assert.equal(value.text.includes("ENOENT"), false);
  assert.equal(JSON.stringify(logs).includes("ENOENT"), false, "the log carries a closed code, not the message");
  assert.equal(logs[0].error, "unknown_error");
});

test("malformed envelopes (null, a string, no outcome, an unknown outcome, no message) all become the try-again sentence", () => {
  for (const envelope of [null, undefined, "ok", 7, [], {}, { ok: true }, { ok: true, result: {} },
    { ok: true, result: { outcome: "paused", message: "Paused." } },
    { ok: true, result: { outcome: "removed" } },
    { ok: true, result: { outcome: "removed", message: "  " } }]) {
    const mapped = mapArchiveResult(envelope);
    assert.equal(mapped.isError, true, JSON.stringify(envelope));
    assert.equal(mapped.text, `Error: ${ARCHIVE_SENTENCES.tryAgain}`);
  }
  assert.equal(archiveTryAgain("x").success, false);
});

// ── Two programs and no id: ask which, by the athlete's own names ────────────

test("needs_program_choice: not an error; lists only the athlete's own programs, newest first, in plain words", async () => {
  const detail = {
    candidates: [
      { queueId: "queue_5k_20261012_090000", title: "Run a faster 5K", state: "active" },
      { queueId: "queue_str_20261001_090000", title: "Build strength", state: "paused_by_person" },
      { queueId: "queue_old_20260920_090000", title: null, state: "resting" },
    ],
  };
  const { value, logs } = await archive({}, bridgeReturning(refused("needs_program_choice", detail)));
  assert.equal(value.isError, false);
  const parsed = JSON.parse(value.text) as { status: string; message: string; programs: Array<Record<string, unknown>> };
  assert.equal(parsed.status, "needs_program_choice");
  assert.equal(parsed.message, ARCHIVE_SENTENCES.choose);
  assert.deepEqual(parsed.programs, [
    { programId: "queue_5k_20261012_090000", title: "Run a faster 5K", state: "running" },
    { programId: "queue_str_20261001_090000", title: "Build strength", state: "paused" },
    { programId: "queue_old_20260920_090000", title: null, state: "resting" },
  ]);
  assert.equal(logs[0].success, true);
  assert.equal(logs[0].archive_result, "needs_program_choice");
});

test("needs_program_choice: capped at six, junk skipped, titles cut and scrubbed", () => {
  const candidates = [
    ...Array.from({ length: 9 }, (_, i) => ({ queueId: `queue_${i}_20261001_09000${i}`, title: `Program ${i}`, state: "active" })),
  ];
  const six = JSON.parse(mapArchiveResult(refused("needs_program_choice", { candidates })).text) as { programs: unknown[] };
  assert.equal(six.programs.length, 6);

  const messy = {
    candidates: [
      null, 7, "queue_x", { title: "no id" }, { queueId: "" }, { queueId: "x".repeat(201), title: "too long an id" },
      { queueId: "queue_ok_20261001_090000", title: `  ${"A".repeat(200)}  `, state: "not_a_state" },
      { queueId: "queue_mail_20261001_090000", title: "write to me@example.com", state: "active" },
    ],
  };
  const parsed = JSON.parse(mapArchiveResult(refused("needs_program_choice", messy)).text) as { programs: Array<{ programId: string; title: string | null; state: string | null }> };
  assert.equal(parsed.programs.length, 2);
  assert.equal(parsed.programs[0].title?.length, 80);
  assert.equal(parsed.programs[0].state, null);
  assert.equal(parsed.programs[1].title, "write to [EMAIL_REDACTED]");

  for (const detail of [undefined, null, "x", {}, { candidates: "no" }]) {
    const none = JSON.parse(mapArchiveResult(refused("needs_program_choice", detail)).text) as { programs: unknown[] };
    assert.deepEqual(none.programs, []);
  }
});

// ── Thrown bridge errors: the 403 before the functions deploy, and the network ──

test("a thrown 403 (the functions are not deployed yet), a 401 and a network error all give the same try-again sentence", async () => {
  const cases: Array<[unknown, string]> = [
    [Object.assign(new Error("Request failed with status code 403 for https://internal/coreToolsBridge"), { response: { status: 403 } }), "tool_not_allowed"],
    [Object.assign(new Error("forbidden"), { status: 403 }), "tool_not_allowed"],
    [Object.assign(new Error("unauthenticated"), { response: { status: 401 } }), "bridge_unauthenticated"],
    [Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:443"), { code: "ECONNREFUSED" }), "bridge_unreachable"],
    [new Error("timeout of 120000ms exceeded"), "bridge_unreachable"],
    ["a string was thrown", "bridge_unreachable"],
    [null, "bridge_unreachable"],
  ];
  for (const [thrown, code] of cases) {
    assert.equal(thrownBridgeCodeOf(thrown), code);
    const { value, logs } = await archive({ programId: TYPED_ID }, {
      callBridge: async () => {
        throw thrown;
      },
    });
    assert.equal(value.isError, true);
    assert.equal(value.text, `Error: ${ARCHIVE_SENTENCES.tryAgain}`);
    assert.equal(value.text.includes("403") || value.text.includes("ECONNREFUSED") || value.text.includes("internal"), false);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].userPseudonym, TEST_CLAIMS.sub);
    assert.equal(logs[0].error, code);
    assert.equal(JSON.stringify(logs).includes("ECONNREFUSED"), false, "the log has a closed code, not the error text");
  }
});

test("the tool_not_allowed envelope (the emulator path, no thrown status) gives the same sentence", async () => {
  const { value, logs } = await archive({ programId: TYPED_ID }, bridgeReturning({ ok: false, error: "tool_not_allowed" }));
  assert.equal(value.text, `Error: ${ARCHIVE_SENTENCES.tryAgain}`);
  assert.equal(logs[0].error, "tool_not_allowed");
});

// ── No id echoed anywhere ────────────────────────────────────────────────────

test("the typed program id appears in no reply and no log line, for every outcome and refusal", async () => {
  const envelopes = [
    ...(["removed", "refund_pending", "open_in_app", "already_replaced"] as const).map(ok),
    ...["not_found", "permission_denied", "missing_required_arg", "archive_failed", "tool_not_allowed", "whatever"].map((c) => refused(c)),
  ];
  for (const envelope of envelopes) {
    const { value, logs } = await archive({ programId: TYPED_ID }, bridgeReturning(envelope));
    assert.equal(value.text.includes(TYPED_ID), false);
    assert.equal(JSON.stringify(logs).includes(TYPED_ID), false);
    assert.equal(JSON.stringify(logs).includes("profile_test_1"), false, "the profile id is never logged either");
  }
});

// ── Logging: the pseudonym on every path, including the catch ────────────────

test("the pseudonym is logged on success, refusal, scope, rate limit, thrown bridge and the catch", async () => {
  const pseudonym = TEST_CLAIMS.sub;
  const success = await archive({ programId: TYPED_ID }, bridgeReturning(ok("removed")));
  const refusal = await archive({ programId: TYPED_ID }, bridgeReturning(refused("not_found")));
  const scope = await archive({ programId: TYPED_ID }, bridgeReturning(ok("removed")), { ...TEST_CLAIMS, scope: "training:read" });
  const thrown = await archive({ programId: TYPED_ID }, { callBridge: async () => { throw new Error("down"); } });

  const limited = { ...TEST_CLAIMS, sub: "pseudonym_rate_limited" };
  for (let i = 0; i < 60; i++) checkWriteRateLimit(limited.sub);
  const rate = await archive({ programId: TYPED_ID }, bridgeReturning(ok("removed")), limited);

  // The catch: a claims object whose scope cannot be read, which throws inside the handler's try.
  const hostile = { ...TEST_CLAIMS, get scope(): string { throw new Error("boom with a secret path /x/y"); } } as McpTokenClaims;
  const caught = await archive({ programId: TYPED_ID }, bridgeReturning(ok("removed")), hostile);

  const expectations: Array<[string, { value: { isError: boolean; text: string }; logs: Array<Record<string, unknown>> }, string, string]> = [
    ["success", success, pseudonym, "removed"],
    ["refusal", refusal, pseudonym, "not_found"],
    ["scope", scope, pseudonym, "scope_required"],
    ["thrown bridge", thrown, pseudonym, "bridge_unreachable"],
    ["rate limit", rate, "pseudonym_rate_limited", "rate_limited"],
    ["catch", caught, pseudonym, "manage_program_failed"],
  ];
  for (const [label, outcome, expectedPseudonym, code] of expectations) {
    const lines = outcome.logs.filter((l) => l.tool === "manage_program");
    assert.equal(lines.length, 1, `${label}: exactly one tool_call line`);
    assert.equal(lines[0].userPseudonym, expectedPseudonym, `${label}: the pseudonym, not "anonymous"`);
    assert.equal(lines[0].archive_result, code, label);
  }
  assert.equal(success.logs[0].success, true);
  assert.equal(refusal.logs[0].success, false);
  assert.equal(scope.value.text, "Error: training:write scope required");
  assert.match(rate.value.text, /^Error: Write rate limit of \d+ writes per hour exceeded/);
  assert.equal(caught.value.text, `Error: ${ARCHIVE_SENTENCES.tryAgain}`);
  assert.equal(JSON.stringify(caught.logs).includes("secret path"), false, "the catch logs the error name only");
});

test("a refused call (scope or rate limit) never reaches the bridge", async () => {
  let calls = 0;
  const deps = { callBridge: async () => { calls++; return ok("removed") as never; } };
  await archive({ programId: TYPED_ID }, deps, { ...TEST_CLAIMS, scope: "training:read" });
  await archive({ programId: TYPED_ID }, deps, null);
  assert.equal(calls, 0);
});

// ── Source contracts: the connector no longer writes the program, in any way ─

test("source contract: bridge only; no queue write, no archived marker, no direct read, no capture copy", () => {
  const source = readFileSync(new URL("../manage_program.js", import.meta.url), "utf8");
  assert.match(source, /callCoreBridge/);
  assert.doesNotMatch(source, /db\.collection|profileSubcollection|getActiveQueueDocuments|verifySessionOwnership|verifyQueueOwnership/);
  assert.doesNotMatch(source, /\.(set|update|add|delete|create)\s*\(/);
  assert.doesNotMatch(source, /runTransaction|batch\s*\(/);
  for (const word of ["archived_at", "captureBeforeRemoval", "removal_capture", "ownership.js"]) {
    assert.equal(source.includes(word), false, word);
  }
  assert.doesNotMatch(source, /status:\s*"archived"/);
});
