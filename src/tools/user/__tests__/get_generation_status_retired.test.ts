/**
 * GL-I43 (Spring Tide 1.2.0): get_generation_status retirement (node:test,
 * no extra dependencies; matches every sibling in this folder). Run after
 * build: node --test dist/tools/user/__tests__/
 *
 * No registered tool hands out a job id for get_generation_status to poll.
 * generate_weekly_plan (the tool that used to produce one) was retired in
 * GL-I16, and its replacement, generate_program, runs synchronously and
 * returns no jobId. Leaving get_generation_status registered would mean
 * every real invocation returns nothing useful. Two things had to both be
 * true at once, and this file pins both:
 *
 *   1. UNREGISTERED: src/index.ts no longer imports or calls
 *      registerGetGenerationStatus. The tool must not appear in the live
 *      tool list any AI client discovers. Checked by reading src/index.ts's
 *      own source text (not by booting the server): index.ts constructs a
 *      fresh McpServer and calls every registerX(server) inline inside its
 *      POST /mcp route handler, with no separately-exported "register
 *      everything" function to import in isolation the way every OTHER
 *      tool's own registration test does (see list_goals.test.ts,
 *      resolve_exercise_ids.test.ts, etc.). Reading the source is the
 *      lightest-weight way to pin this without booting Express/auth.
 *   2. KEPT, NOT DELETED: registerGetGenerationStatus itself still exists
 *      and still registers correctly when called directly. The build
 *      brief's explicit "keep the module in place, delete nothing" means a
 *      future restore, or a reader tracing history, still finds a working
 *      function, not a broken one.
 */

import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerGetGenerationStatus } from "../get_generation_status.js";

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
  registerGetGenerationStatus(
    fakeServer as unknown as Parameters<typeof registerGetGenerationStatus>[0],
  );
  assert.ok(captured, "get_generation_status still registers when called directly");
  return captured;
}

test("KEPT: registerGetGenerationStatus still registers with its real name and schema", () => {
  const tool = captureRegistration();
  assert.equal(tool.name, "get_generation_status");
  assert.equal(tool.title, "Get Generation Status");
  assert.deepEqual(
    tool.schemaKeys.sort(),
    ["jobId"].sort(),
  );
});

// ── Part 2: not wired into the live server (source contract on index.ts) ──

const indexSource = readFileSync(new URL("../../../../src/index.ts", import.meta.url), "utf-8");

test("RETIRED: src/index.ts no longer imports registerGetGenerationStatus", () => {
  assert.doesNotMatch(
    indexSource,
    /import\s*\{\s*registerGetGenerationStatus\s*\}/,
  );
});

test("RETIRED: src/index.ts no longer calls registerGetGenerationStatus(server)", () => {
  assert.doesNotMatch(indexSource, /registerGetGenerationStatus\s*\(\s*server\s*\)/);
});

test("sanity: a SIBLING registration call is still found in indexSource", () => {
  // Proves indexSource actually loaded real content (not empty/wrong path)
  // and the regexes above are the right shape to find a live call.
  assert.match(indexSource, /registerResolveExerciseIds\s*\(\s*server\s*\)/);
});
