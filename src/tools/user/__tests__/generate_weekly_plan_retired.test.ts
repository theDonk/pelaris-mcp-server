/**
 * GL-I16 (Spring Tide 1.2.0) — generate_weekly_plan retirement (node:test, no
 * extra dependencies; matches every sibling in this folder). Run after
 * build: node --test dist/tools/user/__tests__/
 *
 * /generateProgramHttp (the endpoint generate_weekly_plan.ts calls) is
 * retired in this release, so leaving the tool registered would mean it
 * starts 404ing on every real invocation. Two things had to both be true at
 * once, and this file pins both:
 *
 *   1. UNREGISTERED: src/index.ts no longer imports or calls
 *      registerGenerateWeeklyPlan — the tool must not appear in the live
 *      tool list any AI client discovers. Checked by reading src/index.ts's
 *      own source text (not by booting the server): index.ts constructs a
 *      fresh McpServer and calls every registerX(server) inline inside its
 *      POST /mcp route handler, with no separately-exported "register
 *      everything" function to import in isolation the way every OTHER
 *      tool's own registration test does (see list_goals.test.ts,
 *      resolve_exercise_ids.test.ts, etc.) — reading the source is the
 *      lightest-weight way to pin this without booting Express/auth.
 *   2. KEPT, NOT DELETED: registerGenerateWeeklyPlan itself still exists and
 *      still registers correctly when called directly — the build brief's
 *      explicit "keep the module in place, delete nothing" (a future
 *      restore, or a reader tracing history, still finds a working
 *      function, not a broken one).
 */

import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerGenerateWeeklyPlan } from "../generate_weekly_plan.js";

// ── Part 1: still a real, working registration (module kept, not deleted) ──

interface CapturedTool {
  name: string;
  title: string;
  annotations: Record<string, unknown>;
  schemaKeys: string[];
}

function captureRegistration(): CapturedTool {
  let captured: CapturedTool | null = null;
  const fakeServer = {
    registerTool: (name: string, config: Record<string, unknown>) => {
      captured = {
        name,
        title: config.title as string,
        annotations: config.annotations as Record<string, unknown>,
        schemaKeys: Object.keys(config.inputSchema as Record<string, unknown>),
      };
    },
  };
  registerGenerateWeeklyPlan(
    fakeServer as unknown as Parameters<typeof registerGenerateWeeklyPlan>[0],
  );
  assert.ok(captured, "generate_weekly_plan still registers when called directly");
  return captured;
}

test("KEPT: registerGenerateWeeklyPlan still registers with its real name and schema", () => {
  const tool = captureRegistration();
  assert.equal(tool.name, "generate_weekly_plan");
  assert.equal(tool.title, "Generate Weekly Plan");
  assert.deepEqual(
    tool.schemaKeys.sort(),
    ["focus", "daysAvailable", "intensityPreference", "notes", "durationWeeks", "startDate"].sort(),
  );
});

// ── Part 2: not wired into the live server (source contract on index.ts) ──

const indexSource = readFileSync(new URL("../../../../src/index.ts", import.meta.url), "utf-8");

test("RETIRED: src/index.ts no longer imports registerGenerateWeeklyPlan", () => {
  assert.doesNotMatch(
    indexSource,
    /import\s*\{\s*registerGenerateWeeklyPlan\s*\}/,
  );
});

test("RETIRED: src/index.ts no longer calls registerGenerateWeeklyPlan(server)", () => {
  assert.doesNotMatch(indexSource, /registerGenerateWeeklyPlan\s*\(\s*server\s*\)/);
});

test("sanity: the source check isn't vacuous — a SIBLING registration call is still found", () => {
  // Proves indexSource actually loaded real content (not empty/wrong path)
  // and the regexes above are the right shape to find a live call.
  assert.match(indexSource, /registerGenerateProgram\s*\(\s*server\s*\)/);
});
