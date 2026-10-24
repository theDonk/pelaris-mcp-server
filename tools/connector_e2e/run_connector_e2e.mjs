#!/usr/bin/env node
// Pelaris 1.4 connector, end to end, LOCAL ONLY (release readiness, 22/10/2026).
//
// Drives the built gateway (this repo) with a REAL MCP client (@modelcontextprotocol/sdk, streamable HTTP)
// as seeded connector people, against the local Firebase emulators and the local Pelaris functions
// (coreToolsBridge, the same code that ships). Nothing here can reach production: it refuses unless the
// Firestore host and the gateway are loopback and the signing secret is the runner's published dummy.
//
//   Stack (another terminal, holds the emulator lock for the whole session; Ctrl-C or TERM stops it):
//     the Pelaris local launcher from a wayfinder checkout, with sends off (emulators, functions and web only)
//
//   Then ONE command from PowerShell, in this repo (build once first: npm run build):
//     node tools/connector_e2e/run_connector_e2e.mjs --start-gateway --transcript <file.md>
//
//   --start-gateway   starts the gateway for you under wayfinder's egress guard (scripts/run_local_gateway.sh,
//                     port 8790, bounded to 15 minutes), tees its log, and stops it at the end. Without it the
//                     script expects a gateway already running at --gateway (default http://127.0.0.1:8790);
//                     pass --gateway-log <file> to also check the log lines.
//   --reseed          first rewrite the five people with the launcher's own seeds (needed for a second run)
//   --transcript F    write the full transcript (every call and reply) and the result table to F.
//   --wayfinder-dir D the wayfinder checkout that holds tools/emulator/with_egress_guard.sh
//                     (default ../wayfinder, a sibling checkout).
//
// The people are the launcher's own (nothing is added to its seed):
//   n1-connector-noplan.b2ab   a ChatGPT-made profile, no intake, no program
//   n2-connector-plan.b2ab     a Claude-made profile with a program
//   unstarted.r14              one program built and NOT started (Remove still works)
//   behind.r14                 one program STARTED (Remove declines)
//   two.r14                    two live programs
// The run MUTATES the seeded people (n1 completes an intake, unstarted loses its program), so a second run
// against the same session stops at its own precondition check (exit 2) and prints the re-seed commands.
//
// Tokens: minted locally exactly the way the OAuth server mints them (HS256 over the dummy secret, the same
// claims, the same pseudonym, a mcp_tokens/{sha256} document), because a real consent screen needs a person.
// The gateway still verifies the signature, the audience and the token document, which the first checks prove.
//
// Exit codes: 0 all assertions passed; 1 an assertion failed; 2 a precondition failed (nothing was called).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

// ── arguments and safety refusals (before anything is imported that could connect) ───────────────────────────

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const hasFlag = (flag) => process.argv.includes(flag);

const DUMMY = "b0-acceptance-dummy-not-a-secret-0000000000000000000000000000";
const GATEWAY = (argValue("--gateway") ?? "http://127.0.0.1:8790").replace(/\/+$/, "");
const START_GATEWAY = hasFlag("--start-gateway");
const TRANSCRIPT = argValue("--transcript");
const WAYFINDER_DIR = argValue("--wayfinder-dir") ?? process.env.WAYFINDER_DIR ?? path.resolve("..", "wayfinder");
const PROJECT = argValue("--project") ?? "wayfinder-ai-fitness";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const CF_BASE = process.env.CF_BASE_URL || `http://127.0.0.1:5001/${PROJECT}/australia-southeast1`;
const SECRET = process.env.MCP_JWT_SECRET || DUMMY;
const GATEWAY_PORT = (() => { try { return new URL(GATEWAY).port || "8790"; } catch { return "8790"; } })();
let gatewayLog = argValue("--gateway-log");

function refuse(message) {
  process.stderr.write(`[connector_e2e] REFUSED: ${message}\n`);
  process.exit(64);
}
const loopbackHostPort = (v) => /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(v);
const loopbackUrl = (v) => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/.*)?$/.test(v);
if (!loopbackHostPort(FIRESTORE_HOST)) refuse(`FIRESTORE_EMULATOR_HOST must be a loopback host:port (got ${FIRESTORE_HOST})`);
if (!loopbackUrl(GATEWAY)) refuse(`--gateway must be a loopback http URL (got ${GATEWAY})`);
if (!loopbackUrl(CF_BASE)) refuse(`CF_BASE_URL must be a loopback http URL (got ${CF_BASE})`);
if (SECRET !== DUMMY) refuse("MCP_JWT_SECRET must be the runner's published dummy (this client mints test tokens only)");
// Everything below talks to the emulator through this variable; set it so firebase-admin never looks for credentials.
process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_HOST;
for (const key of ["GOOGLE_APPLICATION_CREDENTIALS"]) delete process.env[key];

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { initializeApp } = await import("firebase-admin/app");
const { getFirestore } = await import("firebase-admin/firestore");

const db = getFirestore(initializeApp({ projectId: PROJECT }, "connector-e2e"));

// ── constants that mirror the gateway and the OAuth server ───────────────────────────────────────────────────

const AUDIENCE = "https://api.pelaris.io/mcp";
const ISSUER = "https://api.pelaris.io";
const SCOPES = ["profile:read", "training:read", "training:write", "health:read", "health:write", "coach:read", "offline_access"];
const LINK_PROGRAM = "https://coach.pelaris.io/start/program";
const LINK_TRAIN = "https://coach.pelaris.io/start/train";
const EM_DASH = "\u2014";
const EN_DASH = "\u2013";

const CLAUDE = { id: "pelaris-claude", platform: "claude", assistantClass: "claude", name: "Claude" };
const CHATGPT = { id: "dyn-b2ab0a1b2c3d", platform: "chatgpt", assistantClass: "chatgpt", name: "ChatGPT" };

/** The seeded people this run signs in as. `uid` is also the profile id for all of them. */
const PEOPLE = {
  newcomer: { label: "n1-connector-noplan.b2ab", uid: "b2ab_n1_noplan_0000001", client: CHATGPT },
  planned: { label: "n2-connector-plan.b2ab", uid: "b2ab_n2_plan_000000001", client: CLAUDE },
  unstarted: { label: "unstarted.r14", uid: "r14_unstarted", client: CLAUDE },
  started: { label: "behind.r14", uid: "r14_behind", client: CLAUDE },
  two: { label: "two.r14", uid: "r14_two", client: CLAUDE },
};

/** The two seeds that write the five people (both idempotent: each person is deleted and rewritten). Emulator only. */
const RESEED_SCRIPTS = ["tools/batch2a_seed/b_profile.cjs", "tools/release_1_4_accept/release_personas.cjs"];
const RESEED_HELP = [
  "Re-seed the people this run changes: add --reseed to the same command, or by hand from the wayfinder checkout:",
  `  cd ${WAYFINDER_DIR}`,
  ...RESEED_SCRIPTS.map((script) => `  bash tools/batch1_accept/node_guarded.sh ${script}`),
  "or restart the launcher, which seeds them all.",
].join("\n");

// ── tokens ───────────────────────────────────────────────────────────────────────────────────────────────────

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function signJwt(payload) {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64(payload);
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`, "utf8").digest("base64url");
  return `${head}.${body}.${sig}`;
}
const sha256Hex = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
/** HMAC-SHA256(uid:clientId) hex, as functions/src/mcp/pseudonym_service.ts. */
const pseudonymOf = (uid, clientId) => crypto.createHmac("sha256", SECRET).update(`${uid}:${clientId}`, "utf8").digest("hex");

/** Mint an access token for a person. `writeDoc: false` and `revoked: true` build the two refusal cases. */
async function mintToken(person, { writeDoc = true, revoked = false } = {}) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const pseudonym = pseudonymOf(person.uid, person.client.id);
  const token = signJwt({
    sub: pseudonym, scope: SCOPES.join(" "), platform: person.client.platform, profile_id: person.uid,
    client_id: person.client.id, aud: AUDIENCE, iss: ISSUER, iat: nowSeconds, exp: nowSeconds + 3600,
    // A unique id so two tokens for one person differ (the token document is keyed by the token's hash).
    jti: crypto.randomUUID(),
  });
  if (writeDoc) {
    await db.collection("mcp_tokens").doc(sha256Hex(token)).set({
      uid: person.uid, profile_id: person.uid, client_id: person.client.id, client_name: person.client.name,
      scopes: SCOPES, platform: person.client.platform, pseudonym, revoked,
      createdAt: new Date(), last_used_at: new Date(), minted_email_verified: true,
      assistant_class: person.client.assistantClass, type: "access", expiresAt: new Date((nowSeconds + 3600) * 1000),
    });
  }
  return { token, pseudonym };
}

// ── the oracle: an independent reading of the seeded people straight from the emulator ───────────────────────

const plain = (value) => JSON.parse(JSON.stringify(value, (_key, v) =>
  v && typeof v === "object" && typeof v.toMillis === "function" ? { __ts: v.toMillis() } : v));

async function readProfile(uid) {
  const snap = await db.collection("profiles").doc(uid).get();
  return snap.exists ? plain(snap.data()) : null;
}
async function readQueue(uid, queueId) {
  const snap = await db.collection("profiles").doc(uid).collection("queues").doc(queueId).get();
  return snap.exists ? plain(snap.data()) : null;
}
async function queueCount(uid) {
  return (await db.collection("profiles").doc(uid).collection("queues").count().get()).data().count;
}
async function readServerState(uid, queueId) {
  const snap = await db.collection("profiles").doc(uid).collection("queue_server_state").doc(queueId).get();
  return snap.exists ? plain(snap.data()) : null;
}
/** Entries of the person's own list that are programs they hold (not manual, not retired or removed). */
function liveProgramEntries(profile) {
  const raw = Array.isArray(profile?.active_queues) ? profile.active_queues : [];
  return raw.filter((e) => e && typeof e === "object"
    && e.queue_id !== "manual_workouts" && e.methodology_id !== "manual" && e.program_id !== "manual"
    && !e.retired_at && !e.superseded_by && !e.removed_at);
}
const entryOf = (profile, queueId) => (profile?.active_queues ?? []).find((e) => e?.queue_id === queueId);

// ── results ──────────────────────────────────────────────────────────────────────────────────────────────────

const results = [];
let currentGroup = "";
function check(id, description, ok, detail = "") {
  results.push({ id, group: currentGroup, description, ok: ok === true, skipped: ok === null, detail: String(detail) });
  const tag = ok === null ? "SKIP" : ok ? "PASS" : "FAIL";
  process.stdout.write(`  ${tag}  ${id}  ${description}${ok === true || detail === "" ? "" : `\n        ${detail}`}\n`);
}
function info(id, description) {
  results.push({ id, group: currentGroup, description, ok: true, skipped: false, info: true, detail: "" });
  process.stdout.write(`  INFO  ${id}  ${description}\n`);
}
function group(name) {
  currentGroup = name;
  process.stdout.write(`\n${name}\n`);
}

const calls = []; // every tools/call the client made, in order
const runStartMs = Date.now();
const people = {}; // key -> { session, pseudonym, profile (before), email, programIds }

function tryParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function openSession(key) {
  const person = PEOPLE[key];
  const { token, pseudonym } = await mintToken(person);
  const transport = new StreamableHTTPClientTransport(new URL(`${GATEWAY}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: `pelaris-connector-e2e-${person.client.assistantClass}`, version: "1.0.0" });
  await client.connect(transport);
  return { client, token, pseudonym };
}

/** One tools/call through the real client; recorded for the transcript, the hygiene scan and the log check. */
async function call(key, tool, args = {}) {
  const state = people[key];
  const record = { person: key, label: PEOPLE[key].label, tool, args, at: Date.now() };
  try {
    const reply = await state.session.client.callTool({ name: tool, arguments: args });
    record.isError = reply.isError === true;
    record.text = (reply.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  } catch (error) {
    record.isError = true;
    record.thrown = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    record.text = "";
  }
  record.json = tryParse(record.text);
  calls.push(record);
  return record;
}

// ── the reply hygiene scan: no id, no em dash ────────────────────────────────────────────────────────────────

const PII_KEYS = new Set(["uid", "userId", "ownerUid", "owner_uid", "profileId", "profile_id", "email", "displayName", "createdBy", "phone"]);
/**
 * What a reply must never carry: the person's account identifiers (uid, profile id, email, pseudonym, token) and any
 * PII-named key with a real value. A PROGRAM id is the one id a reply may carry, and only as `programId` inside a
 * `programs` list (get_program_status and the program choice), because the assistant must name a program to choose it.
 */
function idLeaks(record) {
  const state = people[record.person];
  const needles = [...state.accountNeedles];
  const programIds = state.programIds;
  const leaks = [];
  const scanString = (value, where) => {
    for (const needle of needles) if (needle && value.includes(needle)) leaks.push(`${where} carries an account identifier`);
    for (const id of programIds) if (id && value.includes(id)) leaks.push(`${where} carries a program id outside a programs list`);
  };
  const walk = (value, where, inPrograms) => {
    if (typeof value === "string") {
      scanString(value, where);
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${where}[${i}]`, inPrograms || where.endsWith("programs")));
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (PII_KEYS.has(k) && v !== "[REDACTED]" && v !== null && v !== "") leaks.push(`${where}.${k} is a PII key with a value`);
        if ((k === "queueId" || k === "queue_id") && v) leaks.push(`${where}.${k} is a raw queue id key`);
        if (k === "programId" && typeof v === "string") {
          if (!(inPrograms || where.endsWith("programs") || /programs\[\d+\]$/.test(where))) leaks.push(`${where}.programId is outside a programs list`);
          continue; // a program id inside a programs list is allowed by design
        }
        walk(v, `${where}.${k}`, inPrograms);
      }
    }
  };
  if (record.json !== null) walk(record.json, "reply", false);
  else scanString(record.text, "reply text");
  return [...new Set(leaks)];
}

// ── gateway start and stop ───────────────────────────────────────────────────────────────────────────────────

let gatewayProcess = null;
let gatewayStarted = false; // true from the moment this script starts a gateway until it has stopped it
let gatewayPid = null;
function bashPath() {
  if (process.platform === "win32") {
    for (const candidate of ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return "bash";
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function healthOnce() {
  try {
    const response = await fetch(`${GATEWAY}/health`, { signal: AbortSignal.timeout(2000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function startGateway() {
  if (!fs.existsSync(path.join(repoRoot, "dist", "index.js"))) {
    process.stderr.write("[connector_e2e] dist/index.js is missing: run `npm run build` in this repo first (heavy lock)\n");
    process.exit(2);
  }
  const guard = path.posix.join(WAYFINDER_DIR.replace(/\\/g, "/"), "tools/emulator/with_egress_guard.sh");
  if (!fs.existsSync(guard)) {
    process.stderr.write(`[connector_e2e] wayfinder's egress guard wrapper is missing at ${guard} (use --wayfinder-dir)\n`);
    process.exit(2);
  }
  if (await healthOnce()) {
    process.stderr.write(`[connector_e2e] something already answers at ${GATEWAY}; stop it or run without --start-gateway\n`);
    process.exit(2);
  }
  // The guard wrapper tees everything the gateway prints into EGRESS_GUARD_LOG, so that file IS the gateway log
  // (the wrapper's own stdout does not reach a file handle on Windows).
  gatewayLog = path.join(os.tmpdir(), `connector_e2e_gateway_${Date.now()}.log`);
  const out = fs.openSync(`${gatewayLog}.out`, "a");
  const env = {
    ...process.env,
    FIRESTORE_EMULATOR_HOST: FIRESTORE_HOST,
    OAUTH_CF_BASE: `${CF_BASE}/mcpOAuthServer`,
    CF_BASE_URL: CF_BASE,
    PORT: GATEWAY_PORT,
    MCP_JWT_SECRET: DUMMY,
    MCP_OAUTH_IP_HEADER_SECRET: DUMMY,
    MCP_BEARER_TOKEN: "",
    GATEWAY_LIFETIME_SECONDS: "900",
    EGRESS_GUARD_LOG: gatewayLog,
  };
  gatewayProcess = spawn(bashPath(), [guard, "bash", "scripts/run_local_gateway.sh"], { cwd: repoRoot, env, stdio: ["ignore", out, out], windowsHide: true });
  gatewayStarted = true;
  gatewayPid = gatewayProcess.pid;
  gatewayProcess.on("exit", (code) => { gatewayProcess = null; if (code !== 0 && code !== null) process.stderr.write(`[connector_e2e] gateway exited ${code}\n`); });
  for (let i = 0; i < 60; i += 1) {
    if (await healthOnce()) return;
    if (gatewayProcess === null) break;
    await sleep(1000);
  }
  process.stderr.write(`[connector_e2e] the gateway did not come up; its log is ${gatewayLog}\n`);
  stopGateway();
  process.exit(2);
}
/** The Windows pid listening on the gateway port, or null (the msys process tree does not always hang under the spawned bash). */
function listenerPid(port) {
  if (process.platform !== "win32") return null;
  const r = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" });
  for (const line of (r.stdout || "").split(/\r?\n/)) {
    if (/LISTENING/.test(line) && new RegExp(`[:\\]]${port}\\s`).test(line)) return line.trim().split(/\s+/).pop();
  }
  return null;
}
function stopGateway() {
  if (!gatewayStarted) return;
  gatewayStarted = false;
  const pid = gatewayPid;
  if (process.platform === "win32") {
    const listener = listenerPid(GATEWAY_PORT); // only ever the gateway this script started (it refuses to start over another)
    if (listener) spawnSync("taskkill", ["/F", "/T", "/PID", listener], { stdio: "ignore" });
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
  } else {
    process.kill(pid, "SIGTERM");
  }
}
process.on("exit", stopGateway);
process.on("SIGINT", () => { stopGateway(); process.exit(130); });
process.on("SIGTERM", () => { stopGateway(); process.exit(143); });

// ── preconditions ────────────────────────────────────────────────────────────────────────────────────────────

/** --reseed: rewrite the five people in the emulator with the launcher's own seeds (nothing is copied here). */
function reseed() {
  const guarded = path.posix.join(WAYFINDER_DIR.replace(/\\/g, "/"), "tools/batch1_accept/node_guarded.sh");
  for (const script of RESEED_SCRIPTS) {
    process.stdout.write(`  reseeding with ${script}\n`);
    const result = spawnSync(bashPath(), [guarded, script], { cwd: WAYFINDER_DIR, encoding: "utf8", timeout: 10 * 60 * 1000 });
    if (result.status !== 0) {
      process.stderr.write(`[connector_e2e] reseed failed (${script}, exit ${result.status}): ${(result.stderr || result.stdout || "").slice(-600)}\n`);
      process.exit(2);
    }
  }
}

async function preconditions() {
  const problems = [];
  for (const [key, person] of Object.entries(PEOPLE)) {
    const profile = await readProfile(person.uid);
    if (!profile) { problems.push(`${person.label}: no profile in the emulator (is the launcher up and seeded?)`); continue; }
    people[key] = { profile, email: profile.email ?? "", programIds: [], accountNeedles: [] };
    const live = liveProgramEntries(profile);
    people[key].programIds = (profile.active_queues ?? []).map((e) => e?.queue_id).filter(Boolean);
    const intakeDone = Boolean(profile.currentIntakeRunId);
    switch (key) {
      case "newcomer":
        if (intakeDone) problems.push(`${person.label}: already has an intake (a previous run completed it)`);
        if (live.length !== 0) problems.push(`${person.label}: already holds a program`);
        break;
      case "planned":
        if (live.length < 1) problems.push(`${person.label}: expected a program, found none`);
        break;
      case "unstarted": {
        if (live.length !== 1) { problems.push(`${person.label}: expected exactly one live program, found ${live.length} (a previous run removed it)`); break; }
        const queueId = live[0].queue_id;
        const state = await readServerState(person.uid, queueId);
        if (state?.first_completion_at != null) problems.push(`${person.label}: its program has already been started`);
        if (state?.removed_at != null) problems.push(`${person.label}: its program was already removed`);
        break;
      }
      case "started": {
        if (live.length !== 1) { problems.push(`${person.label}: expected exactly one live program, found ${live.length}`); break; }
        const state = await readServerState(person.uid, live[0].queue_id);
        if (state?.first_completion_at == null) problems.push(`${person.label}: its program is not started (no first completion)`);
        break;
      }
      case "two":
        if (live.length !== 2) problems.push(`${person.label}: expected two live programs, found ${live.length}`);
        break;
      default:
        break;
    }
  }
  if (problems.length) {
    process.stderr.write(`[connector_e2e] PRECONDITIONS FAILED, nothing was called:\n  - ${problems.join("\n  - ")}\n\n${RESEED_HELP}\n`);
    process.exit(2);
  }
}

// ── the run ──────────────────────────────────────────────────────────────────────────────────────────────────

const expectedTools = ["complete_intake", "generate_program", "manage_program", "get_program_status", "get_onboarding_status"];

async function main() {
  process.stdout.write(`Pelaris connector end to end (local only)\n  gateway ${GATEWAY}   firestore ${FIRESTORE_HOST}   functions ${CF_BASE}\n`);
  if (hasFlag("--reseed")) reseed();
  if (START_GATEWAY) await startGateway();
  const health = await healthOnce();
  if (!health) {
    process.stderr.write(`[connector_e2e] no gateway answers at ${GATEWAY}. Start the stack, then run with --start-gateway.\n`);
    process.exit(2);
  }
  await preconditions();

  // Account needles per person (never printed in the transcript's checks, only matched against replies).
  for (const [key, person] of Object.entries(PEOPLE)) {
    people[key].pseudonym = pseudonymOf(person.uid, person.client.id);
    people[key].accountNeedles = [person.uid, people[key].email, people[key].pseudonym].filter((v) => typeof v === "string" && v.length > 5);
  }

  // ── 1. the gateway really checks tokens ─────────────────────────────────────────────────────────────────────
  group("1. The gateway checks tokens (so the minted ones prove something)");
  const post = (headers) => fetch(`${GATEWAY}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  check("T1", "no token is refused with 401", (await post({})).status === 401);
  check("T2", "a garbage token is refused with 401", (await post({ authorization: "Bearer not.a.token" })).status === 401);
  {
    const unknown = await mintToken(PEOPLE.planned, { writeDoc: false });
    check("T3", "a correctly signed token with no token document is refused with 401", (await post({ authorization: `Bearer ${unknown.token}` })).status === 401);
    const revoked = await mintToken(PEOPLE.planned, { revoked: true });
    check("T4", "a revoked token is refused with 401", (await post({ authorization: `Bearer ${revoked.token}` })).status === 401);
  }

  // Sessions: one real MCP client per person.
  for (const key of Object.keys(PEOPLE)) people[key].session = await openSession(key);

  // ── 2. the server and its tools ─────────────────────────────────────────────────────────────────────────────
  group("2. The server as an assistant sees it");
  {
    const { client } = people.newcomer.session;
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name);
    const missing = expectedTools.filter((t) => !names.includes(t));
    check("S1", "tools/list carries the program tools", missing.length === 0, `missing: ${missing.join(", ")}`);
    const programTools = listed.tools.filter((t) => ["generate_program", "manage_program", "complete_intake", "get_program_status"].includes(t.name));
    const dashTools = programTools.filter((t) => `${t.description ?? ""} ${t.title ?? ""}`.includes(EM_DASH)).map((t) => t.name);
    check("S2", "the program tools' descriptions hold no em dash", dashTools.length === 0, `em dash in: ${dashTools.join(", ")}`);
    const instructions = client.getInstructions() ?? "";
    // Informational: the server-level instructions are for the model, not read by the athlete. Recorded, not asserted.
    info("S3", `the server instructions hold ${[...instructions].filter((c) => c === EM_DASH).length} em dash(es) (read by the model, not shown to the athlete)`);
  }

  // ── 3. a newcomer with no intake (ChatGPT) ──────────────────────────────────────────────────────────────────
  group("3. A newcomer with no intake, through ChatGPT (n1-connector-noplan.b2ab)");
  {
    const uid = PEOPLE.newcomer.uid;
    const status = await call("newcomer", "get_onboarding_status");
    check("N1", "get_onboarding_status says the next step is complete_intake and there is no program",
      status.json?.next_step === "complete_intake" && status.json?.hasProgram === false, status.text.slice(0, 200));

    const first = await call("newcomer", "generate_program");
    check("N2", "generate_program says needs_intake, with the Pelaris link that starts a program",
      !first.isError && first.json?.state === "needs_intake" && first.json?.link === LINK_PROGRAM, first.text.slice(0, 300));

    const partial = await call("newcomer", "complete_intake", { answers: { is_pregnant: "no", primary_goal: "strength" } });
    const afterPartial = await readProfile(uid);
    check("N3", "complete_intake with a safety answer missing asks for it (clarification_required, not an error) and saves nothing",
      !partial.isError && partial.json?.status === "clarification_required" && !afterPartial.currentIntakeRunId, partial.text.slice(0, 300));

    const full = await call("newcomer", "complete_intake", {
      answers: {
        is_pregnant: "no", has_injuries: "no", primary_goal: "strength", experience_level: "intermediate",
        days_per_week: 3, preferred_units: "metric",
      },
      freeText: { north_star_raw: "Get stronger and keep it up through winter." },
    });
    const afterFull = await readProfile(uid);
    const runId = afterFull?.currentIntakeRunId;
    const runDoc = runId ? (await db.collection("profiles").doc(uid).collection("intakes").doc(runId).get()) : null;
    check("N4", "complete_intake with every safety answer saves: the profile names the intake run and the run is stored as completed",
      !full.isError && full.json?.status === "completed" && Boolean(runId) && afterFull.intakeStatus === "completed" && runDoc?.exists === true && runDoc.get("status") === "completed",
      `${full.text.slice(0, 200)} | currentIntakeRunId=${runId ?? "none"}`);

    const statusAfter = await call("newcomer", "get_onboarding_status");
    check("N5", "get_onboarding_status now says the next step is generate_program",
      statusAfter.json?.next_step === "generate_program" && statusAfter.json?.hasCompletedOnboarding === true, statusAfter.text.slice(0, 200));

    const second = await call("newcomer", "generate_program");
    check("N6", "generate_program now says ready_to_build, with https://coach.pelaris.io/start/program",
      !second.isError && second.json?.state === "ready_to_build" && second.json?.link === LINK_PROGRAM, second.text.slice(0, 300));

    // Give the intake-completed trigger a moment, then prove the connector built nothing: programs are built in Pelaris.
    await sleep(2500);
    const finalProfile = await readProfile(uid);
    check("N7", "nothing was built in the chat: no program document and no entry in the person's list",
      (await queueCount(uid)) === 0 && liveProgramEntries(finalProfile).length === 0, `queues=${await queueCount(uid)} entries=${liveProgramEntries(finalProfile).length}`);
  }

  // ── 4. an athlete with a program (Claude) ───────────────────────────────────────────────────────────────────
  group("4. An athlete who already has a program, through Claude (n2-connector-plan.b2ab)");
  {
    const uid = PEOPLE.planned.uid;
    const before = JSON.stringify((await readProfile(uid)).active_queues);
    const status = await call("planned", "get_onboarding_status");
    check("P1", "get_onboarding_status says the next step is train_today", status.json?.next_step === "train_today" && status.json?.hasProgram === true, status.text.slice(0, 200));
    const reply = await call("planned", "generate_program");
    check("P2", "generate_program says has_program, with https://coach.pelaris.io/start/train",
      !reply.isError && reply.json?.state === "has_program" && reply.json?.link === LINK_TRAIN, reply.text.slice(0, 300));
    const after = JSON.stringify((await readProfile(uid)).active_queues);
    check("P3", "asking for a program changed nothing in their list", before === after);
  }

  // ── 5. archive of an unstarted program ──────────────────────────────────────────────────────────────────────
  group("5. Setting aside a program that has not been started (unstarted.r14)");
  {
    const uid = PEOPLE.unstarted.uid;
    const queueId = people.unstarted.programIds[0];
    const running = await call("unstarted", "get_program_status", { action: "get_current" });
    const listed = running.json?.programs ?? [];
    check("U1", "get_program_status lists the one program as running before the archive",
      listed.length === 1 && listed[0].status === "active", running.text.slice(0, 300));

    const removed = await call("unstarted", "manage_program", { action: "archive" });
    check("U2", "manage_program archive of an unstarted program answers removed, with the link to build a fresh one",
      !removed.isError && removed.json?.status === "removed" && removed.json?.link === LINK_PROGRAM, removed.text.slice(0, 300));

    const profile = await readProfile(uid);
    const entry = entryOf(profile, queueId);
    const queue = await readQueue(uid, queueId);
    check("U3", "in the emulator the person's list marks it removed and not running, and its program document says removed",
      Boolean(entry) && entry.is_active === false && Boolean(entry.removed_at) && queue?.generation_status === "removed",
      `entry=${JSON.stringify(entry)} generation_status=${queue?.generation_status}`);
    check("U4", "the list holds no running program any more (no dangling active pointer)", liveProgramEntries(profile).length === 0);

    const current = await call("unstarted", "get_program_status", { action: "get_current" });
    const stillRunning = (current.json?.programs ?? []).filter((p) => p.status === "active" || p.status === "resting");
    check("U5", "get_program_status get_current never lists the removed program as running",
      !current.isError && stillRunning.length === 0 && (current.json?.programs ?? []).length === 0, current.text.slice(0, 300));

    const history = await call("unstarted", "get_program_status", { action: "list_history" });
    const row = (history.json?.programs ?? []).find((p) => p.programId === queueId);
    check("U6", "get_program_status list_history shows the program with status removed (never active)",
      Boolean(row) && row.status === "removed", history.text.slice(0, 400));

    const next = await call("unstarted", "generate_program");
    check("U7", "generate_program no longer says they hold a program: it says ready_to_build",
      next.json?.state === "ready_to_build" && next.json?.link === LINK_PROGRAM, next.text.slice(0, 300));

    const repeat = await call("unstarted", "manage_program", { action: "archive", programId: queueId });
    const repeatProfile = await readProfile(uid);
    check("U8", "a repeat of the same archive (an assistant retrying) is not an error and changes nothing more",
      !repeat.isError && JSON.stringify(entryOf(repeatProfile, queueId)) === JSON.stringify(entry), repeat.text.slice(0, 300));
  }

  // ── 6. archive of a started program ─────────────────────────────────────────────────────────────────────────
  group("6. A program that has been started (behind.r14)");
  {
    const uid = PEOPLE.started.uid;
    const queueId = people.started.programIds[0];
    const before = JSON.stringify((await readProfile(uid)).active_queues);
    const queueBefore = (await readQueue(uid, queueId))?.generation_status ?? null;
    const reply = await call("started", "manage_program", { action: "archive" });
    check("D1", "manage_program archive of a started program answers open_in_app, with https://coach.pelaris.io/start/train",
      !reply.isError && reply.json?.status === "open_in_app" && reply.json?.link === LINK_TRAIN, reply.text.slice(0, 300));
    check("D2", "the reply names Pause, Stop and Remove in the app", /Pause/.test(reply.json?.message ?? "") && /Remove/.test(reply.json?.message ?? ""), reply.json?.message ?? "");
    const after = JSON.stringify((await readProfile(uid)).active_queues);
    check("D3", "nothing was written: their list and the program document are unchanged",
      before === after && ((await readQueue(uid, queueId))?.generation_status ?? null) === queueBefore);
    const current = await call("started", "get_program_status", { action: "get_current" });
    check("D4", "the program is still listed as running", (current.json?.programs ?? []).some((p) => p.programId === queueId && p.status === "active"), current.text.slice(0, 300));
  }

  // ── 7. two live programs ────────────────────────────────────────────────────────────────────────────────────
  group("7. Two live programs and no program named (two.r14)");
  {
    const uid = PEOPLE.two.uid;
    const ids = people.two.programIds;
    const before = JSON.stringify((await readProfile(uid)).active_queues);
    const ask = await call("two", "manage_program", { action: "archive" });
    const choices = ask.json?.programs ?? [];
    check("C1", "manage_program archive without a programId answers needs_program_choice (not an error) with both programs",
      !ask.isError && ask.json?.status === "needs_program_choice" && choices.length === 2
        && ids.every((id) => choices.some((c) => c.programId === id)), ask.text.slice(0, 500));
    check("C2", "each choice has a title and a state the athlete can read", choices.every((c) => typeof c.title === "string" && c.title.length > 0 && typeof c.state === "string"),
      JSON.stringify(choices));
    check("C3", "nothing was written while asking", before === JSON.stringify((await readProfile(uid)).active_queues));
    const named = await call("two", "manage_program", { action: "archive", programId: ids[0] });
    check("C4", "naming one of them goes on: both are started, so the answer is open_in_app and nothing changes",
      !named.isError && named.json?.status === "open_in_app" && before === JSON.stringify((await readProfile(uid)).active_queues), named.text.slice(0, 300));
    const stranger = "q_not_mine_e2e_zzz";
    const unknown = await call("two", "manage_program", { action: "archive", programId: stranger });
    check("C5", "a program id that is not theirs is refused with a plain sentence that does not echo the typed id",
      unknown.isError && !unknown.text.includes(stranger) && /could not find/i.test(unknown.text), unknown.text.slice(0, 300));
  }

  // ── 8. what every reply may not carry ───────────────────────────────────────────────────────────────────────
  group("8. Every reply: no id, no em dash");
  {
    const dashed = calls.filter((c) => c.text.includes(EM_DASH));
    check("R1", `no reply carries an em dash (${calls.length} replies scanned)`, dashed.length === 0, dashed.map((c) => `${c.label} ${c.tool}`).join("; "));
    const ens = calls.filter((c) => c.text.includes(EN_DASH));
    info("R2", `${ens.length} reply(ies) carry an en dash`);
    const leaking = calls.map((c) => ({ c, leaks: idLeaks(c) })).filter((x) => x.leaks.length);
    check("R3", "no reply carries an account identifier (uid, profile id, email, pseudonym) or a PII key; a program id appears only as programId inside a programs list",
      leaking.length === 0, leaking.map((x) => `${x.c.label} ${x.c.tool}: ${x.leaks.join(", ")}`).join("; "));
    const thrown = calls.filter((c) => c.thrown);
    check("R4", "no call failed at the transport (every call got a tool reply)", thrown.length === 0, thrown.map((c) => `${c.label} ${c.tool}: ${c.thrown}`).join("; "));
  }

  // ── 9. the gateway's log: every call carries a pseudonym ────────────────────────────────────────────────────
  group("9. The gateway log: every call is logged with a pseudonym");
  await sleep(1500);
  if (!gatewayLog || !fs.existsSync(gatewayLog)) {
    check("L1", "every call has a tool_call log line carrying the person's pseudonym", null, "no --gateway-log given and the gateway was not started by this script");
  } else {
    const lines = fs.readFileSync(gatewayLog, "utf8").split(/\r?\n/).map((l) => tryParse(l.trim())).filter(Boolean);
    const toolLines = lines.filter((l) => typeof l.message === "string" && l.message.startsWith("tool_call: ") && Date.parse(l.timestamp) >= runStartMs - 2000);
    const wanted = new Map();
    for (const c of calls) {
      const k = `${c.tool}|${people[c.person].pseudonym}`;
      wanted.set(k, (wanted.get(k) ?? 0) + 1);
    }
    const found = new Map();
    for (const l of toolLines) {
      const k = `${l.tool}|${l.userPseudonym}`;
      found.set(k, (found.get(k) ?? 0) + 1);
    }
    const short = [];
    for (const [k, n] of wanted) if ((found.get(k) ?? 0) < n) {
      const [tool, pseudonym] = k.split("|");
      const who = Object.entries(PEOPLE).find(([key]) => people[key].pseudonym === pseudonym)?.[1].label;
      short.push(`${who} ${tool}: ${n} call(s), ${found.get(k) ?? 0} log line(s)`);
    }
    check("L1", `every call has a tool_call log line carrying the person's pseudonym (${calls.length} calls, ${toolLines.length} tool_call lines)`, short.length === 0, short.join("; "));
    const badPseudonym = toolLines.filter((l) => !/^[0-9a-f]{64}$/.test(String(l.userPseudonym ?? "")));
    check("L2", "every tool_call line's pseudonym is a 64 character hash (never anonymous, never a uid)", badPseudonym.length === 0,
      badPseudonym.map((l) => `${l.tool}: ${l.userPseudonym}`).join("; "));
    const raw = toolLines.filter((l) => {
      const text = JSON.stringify(l);
      return Object.entries(PEOPLE).some(([key, p]) => text.includes(p.uid) || (people[key].email && text.includes(people[key].email)));
    });
    check("L3", "no tool_call line holds a uid, a profile id or an email", raw.length === 0, raw.map((l) => l.tool).join("; "));
    const wholeLog = fs.readFileSync(gatewayLog, "utf8");
    const tokenLeak = Object.keys(PEOPLE).some((key) => people[key].session.token && wholeLog.includes(people[key].session.token));
    check("L4", "no access token appears anywhere in the gateway log", !tokenLeak);
    const uses = lines.filter((l) => l.event === "connector_use");
    const classes = new Set(uses.map((l) => l.client_class));
    check("L5", "connector_use lines name the assistant (chatgpt for n1, claude for the rest)", classes.has("chatgpt") && classes.has("claude"), `seen: ${[...classes].join(", ") || "none"}`);
  }
}

// ── transcript ───────────────────────────────────────────────────────────────────────────────────────────────

function gitShort(cwd) {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "unknown";
}
function gitBranch(cwd) {
  const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "unknown";
}

function writeTranscript(health, startedAt) {
  const passed = results.filter((r) => r.ok && !r.skipped && !r.info).length;
  const failed = results.filter((r) => !r.ok && !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  const lines = [];
  lines.push("# Connector end to end run (local only)", "");
  lines.push(`Run: ${startedAt.toISOString()}`);
  lines.push(`Gateway: pelaris-firebase-mcp ${health?.version ?? "?"} at ${GATEWAY} (repo ${gitBranch(repoRoot)} ${gitShort(repoRoot)})`);
  lines.push(`Pelaris side: coreToolsBridge in the local functions emulator, ${CF_BASE} (wayfinder checkout ${WAYFINDER_DIR}, ${gitBranch(WAYFINDER_DIR)} ${gitShort(WAYFINDER_DIR)})`);
  lines.push(`Data: Firestore emulator ${FIRESTORE_HOST}, made-up people only. Tokens: minted locally (dummy secret), verified by the gateway.`);
  lines.push(`Client: @modelcontextprotocol/sdk streamable HTTP client, the same protocol ChatGPT and Claude speak.`);
  lines.push(`Result: ${passed} passed, ${failed.length} failed, ${skipped.length} skipped.`, "");
  lines.push("## Assertions", "", "| ID | Result | Assertion |", "|---|---|---|");
  for (const r of results) {
    const tag = r.info ? "info" : r.skipped ? "SKIP" : r.ok ? "PASS" : "FAIL";
    lines.push(`| ${r.id} | ${tag} | ${r.description.replace(/\|/g, "/")}${r.ok || r.skipped || !r.detail ? "" : ` (${r.detail.replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 300)})`} |`);
  }
  lines.push("", "## Transcript", "", "Every call the client made, in order. Replies are shown as the assistant received them.", "");
  for (const c of calls) {
    lines.push(`### ${c.label}: ${c.tool}${Object.keys(c.args).length ? ` ${JSON.stringify(c.args)}` : ""}`, "");
    lines.push(`isError: ${c.isError}${c.thrown ? `, thrown: ${c.thrown}` : ""}`, "", "```", c.text || "(no text)", "```", "");
  }
  fs.mkdirSync(path.dirname(path.resolve(TRANSCRIPT)), { recursive: true });
  fs.writeFileSync(TRANSCRIPT, lines.join("\n") + "\n", "utf8");
}

const startedAt = new Date();
let exitCode = 0;
try {
  await main();
} catch (error) {
  process.stderr.write(`[connector_e2e] stopped on an unexpected error: ${error instanceof Error ? error.stack : error}\n`);
  results.push({ id: "X0", group: currentGroup, description: "the run completed without an unexpected error", ok: false, skipped: false, detail: String(error instanceof Error ? error.message : error) });
}
const failed = results.filter((r) => !r.ok && !r.skipped);
const health = await healthOnce();
if (TRANSCRIPT) writeTranscript(health, startedAt);
for (const state of Object.values(people)) { try { await state.session?.client.close(); } catch { /* closing is best effort */ } }
const checks = results.filter((r) => !r.info);
process.stdout.write(`\n${checks.filter((r) => r.ok && !r.skipped).length} passed, ${failed.length} failed, ${checks.filter((r) => r.skipped).length} skipped${TRANSCRIPT ? `. Transcript: ${TRANSCRIPT}` : ""}\n`);
exitCode = failed.length ? 1 : 0;
stopGateway();
process.exit(exitCode);
