// R3 refusals of scripts/run_local_gateway.sh (Pelaris 1.4 B2a lane C, C6 g).
// Each row breaks one rule and expects exit 64 with its reason; nothing here
// starts the gateway (the last check before `exec` is dist/index.js, which a
// row deliberately points away from). node:test, listed in run_tests.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, "run_local_gateway.sh");
const DUMMY = "b0-acceptance-dummy-not-a-secret-0000000000000000000000000000";

function bashPath() {
  if (process.platform === "win32") {
    for (const candidate of ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return "bash";
}

const lockDir = mkdtempSync(join(tmpdir(), "gw-runner-lock-"));
const lockOwner = join(lockDir, "owner").replace(/\\/g, "/");
writeFileSync(lockOwner, "agent=test\n");

const GOOD = {
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
  OAUTH_CF_BASE: "http://127.0.0.1:5001/demo/australia-southeast1/mcpOAuthServer",
  CF_BASE_URL: "http://127.0.0.1:5001/demo/australia-southeast1",
  PORT: "8790",
  MCP_JWT_SECRET: DUMMY,
  MCP_OAUTH_IP_HEADER_SECRET: DUMMY,
  MCP_BEARER_TOKEN: "",
  NODE_OPTIONS: "--require /x/tools/emulator/block_egress.cjs --require /x/tools/emulator/egress_strict.cjs",
  RUNNER_LOCK_OWNER: lockOwner,
};

function run(env) {
  // cwd is a temp dir with no dist/, so a run that passes every rule stops at
  // the dist check and never starts a server.
  const cwd = mkdtempSync(join(tmpdir(), "gw-runner-cwd-"));
  try {
    const clean = { ...process.env };
    for (const key of Object.keys(GOOD)) delete clean[key];
    const r = spawnSync(bashPath(), [runner], { cwd, env: { ...clean, ...env, NODE_OPTIONS: env.NODE_OPTIONS ?? "" }, encoding: "utf8", timeout: 30_000 });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const ROWS = [
  ["no FIRESTORE_EMULATOR_HOST", { FIRESTORE_EMULATOR_HOST: "" }, /FIRESTORE_EMULATOR_HOST is not set/],
  ["a non-loopback FIRESTORE_EMULATOR_HOST", { FIRESTORE_EMULATOR_HOST: "firestore.googleapis.com:443" }, /must be a loopback host:port/],
  ["OAUTH_CF_BASE on production", { OAUTH_CF_BASE: "https://australia-southeast1-wayfinder-ai-fitness.cloudfunctions.net/mcpOAuthServer" }, /OAUTH_CF_BASE must be a loopback/],
  ["CF_BASE_URL unset (bridge_client defaults to production)", { CF_BASE_URL: "" }, /CF_BASE_URL must be a loopback/],
  ["CF_BASE_URL on a localhost look-alike", { CF_BASE_URL: "http://localhost.evil.example:5001" }, /CF_BASE_URL must be a loopback/],
  ["PORT unset", { PORT: "" }, /PORT must be set/],
  ["PORT 8080 (the Firestore emulator)", { PORT: "8080" }, /PORT 8080 is an emulator port/],
  ["PORT 9099 (the Auth emulator)", { PORT: "9099" }, /PORT 9099 is an emulator port/],
  ["a real-looking JWT secret", { MCP_JWT_SECRET: "something-else-entirely-0123456789abcdef" }, /MCP_JWT_SECRET must equal/],
  ["a missing header secret", { MCP_OAUTH_IP_HEADER_SECRET: "" }, /MCP_OAUTH_IP_HEADER_SECRET must equal/],
  ["an admin bearer token", { MCP_BEARER_TOKEN: "admin-token" }, /MCP_BEARER_TOKEN must be empty/],
  ["no egress guard", { NODE_OPTIONS: "" }, /no egress guard/],
  ["the guard without the strict preload", { NODE_OPTIONS: "--require /x/tools/emulator/block_egress.cjs" }, /no strict egress preload/],
  ["the emulator lock not held", { RUNNER_LOCK_OWNER: "/no/such/lock/owner" }, /emulator lock is not held/],
  ["every rule met, but no build", {}, /dist\/index\.js is missing/],
];

for (const [name, change, reason] of ROWS) {
  test(`run_local_gateway refuses: ${name}`, () => {
    const r = run({ ...GOOD, ...change });
    assert.equal(r.status, 64, r.out);
    assert.match(r.out, reason);
  });
}

test("cleanup", () => rmSync(lockDir, { recursive: true, force: true }));
