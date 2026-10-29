#!/usr/bin/env node
// Gateway test runner (Pelaris 1.4 B2a lane C, C6 g; PLAN_B2a R4).
//
//   npm run build && npm test
//
// - Lists every test file explicitly (Git Bash has no `**`, and a test file
//   that is not listed must not be silently skipped: the list is checked
//   against dist/ below).
// - Points the Firestore client at a DEAD loopback port unless an emulator is
//   already set (FIRESTORE_EMULATOR_HOST), so no test can read or write a real
//   project with the machine's or CI's credentials (panel P2-7 d).
// - Sets B2A_GATEWAY_TEST=1, so wayfinder's egress guard (when preloaded)
//   also refuses production Firestore.
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

export const TEST_FILES = [
  "dist/connector/__tests__/redirect_policy.test.js",
  "dist/connector/__tests__/dials.test.js",
  "dist/connector/__tests__/token_access.test.js",
  "dist/connector/__tests__/auth_ownership.test.js",
  "dist/connector/__tests__/return_hook.test.js",
  "dist/connector/__tests__/routes.test.js",
  "dist/connector/__tests__/client_ip_dcr_use.test.js",
  "dist/tools/shared/__tests__/core_adapter.test.js",
  "dist/tools/shared/__tests__/removal_capture.test.js",
  "dist/tools/user/__tests__/connector_truth.test.js",
  "dist/tools/user/__tests__/create_planned_session_core_input.test.js",
  "dist/tools/user/__tests__/generate_program_link.test.js",
  "dist/tools/user/__tests__/generate_weekly_plan_retired.test.js",
  "dist/tools/user/__tests__/get_generation_status_retired.test.js",
  "dist/tools/user/__tests__/injury_and_team_sport_core_bridge.test.js",
  "dist/tools/user/__tests__/list_goals.test.js",
  "dist/tools/user/__tests__/log_session_bridge.test.js",
  "dist/tools/user/__tests__/manage_program_archive.test.js",
  "dist/tools/user/__tests__/program_readers_agree_with_the_app.test.js",
  "dist/tools/user/__tests__/programs_built_in_pelaris_wording.test.js",
  "dist/tools/user/__tests__/resolve_exercise_ids.test.js",
  "dist/tools/user/__tests__/session_modify_mapping.test.js",
  "dist/tools/user/__tests__/swap_exercise_core_input.test.js",
  "dist/__tests__/server_info.test.js",
];

/** Script tests (plain .mjs, not compiled). */
export const SCRIPT_TEST_FILES = ["scripts/run_local_gateway.test.mjs"];

function builtTests(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...builtTests(path));
    else if (name.endsWith(".test.js")) out.push(relative(root, path).split(sep).join("/"));
  }
  return out;
}

const built = builtTests(join(root, "dist"));
const unlisted = built.filter((f) => !TEST_FILES.includes(f));
const missing = TEST_FILES.filter((f) => !built.includes(f));
if (unlisted.length || missing.length) {
  if (unlisted.length) console.error(`[run_tests] built but not listed: ${unlisted.join(", ")}`);
  if (missing.length) console.error(`[run_tests] listed but not built (run npm run build): ${missing.join(", ")}`);
  process.exit(2);
}

const env = {
  ...process.env,
  FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:1",
  B2A_GATEWAY_TEST: "1",
  MCP_BEARER_TOKEN: "",
};
const result = spawnSync(process.execPath, ["--test", ...TEST_FILES, ...SCRIPT_TEST_FILES], { cwd: root, env, stdio: "inherit" });
process.exit(result.status ?? 1);
