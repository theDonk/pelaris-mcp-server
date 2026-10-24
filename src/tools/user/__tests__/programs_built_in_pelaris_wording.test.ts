/**
 * Programs are built in Pelaris, not in the chat (connector rev 2.1, M3, Brad 20/10/2026, BRAD_RETURN #46): nothing the
 * assistant reads may still promise a program built in the conversation. node:test, no Firestore.
 *
 * The server instruction (src/index.ts) is the one that matters most: B2a's FL-3 line told the assistant to "offer to
 * set up the person's training plan right here in the conversation", which, with the old generate_program, sent people
 * down the 6 to 9 minute build that failed on 16/10. The reworded line ships in the same release as the gateway stack.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerCompleteIntake } from "../complete_intake.js";
import { GENERATE_PROGRAM_DESCRIPTION } from "../generate_program.js";
import { MANAGE_PROGRAM_DESCRIPTION } from "../manage_program.js";
import { hasDash } from "./mcp_harness.js";

const root = new URL("../../../../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), "utf8");

/** The server instruction as the assistant reads it: comments dropped, the concatenated literals joined. */
function serverInstructions(): string {
  const source = read("src/index.ts")
    .replace(/\r\n/g, "\n")
    .replace(/^\s*\/\/.*$/gm, "");
  const start = source.indexOf("instructions:");
  assert.ok(start > 0, "found the instructions");
  const end = source.indexOf("});", start);
  const block = source.slice(start, end);
  return [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join("");
}

test("the server instruction no longer promises a plan built in the conversation", () => {
  const text = serverInstructions();
  assert.equal(text.includes("right here in the conversation"), false);
  assert.equal(text.includes("set up the person's training plan"), false);
  assert.ok(text.includes("Programs are built in Pelaris, not in this chat"));
  assert.ok(text.includes("plan single sessions or a week at a time here"));
});

test("the server instruction hands over the link and keeps the intake, the first session and the units", () => {
  const text = serverInstructions();
  assert.ok(text.includes("complete_intake"));
  assert.ok(text.includes("call generate_program for the link that opens their program in Pelaris"));
  assert.ok(text.includes("offer to do their first session today"));
  assert.ok(text.includes("When it reports preferred_units, use them and do not ask for units again."));
  assert.ok(text.includes("Offer this once; if the person declines, carry on with what they asked."));
  assert.ok(text.includes("(its next_step is complete_intake or generate_program)"));
});

test("the connector-cert wording is untouched: general information, not medical advice, AI-generated", () => {
  const text = serverInstructions();
  for (const needle of ["not medical", "Do not diagnose or treat", "licensed professional", "All coaching output is AI-generated."]) {
    assert.ok(text.includes(needle), needle);
  }
});

test("the new instruction wording has no em dash", () => {
  const text = serverInstructions();
  const added = text.slice(text.indexOf("When get_onboarding_status"));
  assert.equal(hasDash(added), false);
});

test("complete_intake points to the link, not to a generated program", () => {
  let description = "";
  registerCompleteIntake({
    registerTool: (_name: string, config: { description?: string }) => {
      description = config.description ?? "";
    },
  } as never);
  assert.ok(description.includes("Pelaris can build their program"));
  assert.ok(description.includes("call generate_program for the link that starts their program in Pelaris"));
  assert.equal(description.includes("can be generated"), false);
});

test("no tool description the assistant reads says a program is generated or built in this chat", () => {
  for (const [name, text] of [["generate_program", GENERATE_PROGRAM_DESCRIPTION], ["manage_program", MANAGE_PROGRAM_DESCRIPTION]]) {
    assert.doesNotMatch(text, /generate and enrol|enrol it as your active program|generate a complete/i, name);
  }
  assert.match(GENERATE_PROGRAM_DESCRIPTION, /does not build one in this chat/);
});

test("README, server.json and package.json: the new words and one version", () => {
  const readme = read("README.md");
  assert.equal(readme.includes("Generate and enrol"), false);
  assert.equal(readme.includes("Build me a 4-week running plan"), false);
  assert.ok(readme.includes("Get the link that starts your training program in Pelaris"));
  assert.ok(readme.includes("Pause, Stop and Remove"));
  const server = JSON.parse(read("server.json")) as { version: string; description: string };
  const pkg = JSON.parse(read("package.json")) as { version: string };
  assert.equal(server.version, "2.3.0");
  assert.equal(pkg.version, server.version, "/health reads package.json, the registry reads server.json");
  assert.ok(server.description.endsWith("Programs are built in Pelaris."));
  assert.equal(hasDash(server.description), false);
  assert.equal(server.description.includes("plan training programs"), false);
});

test("the long-build limiter is kept for the future ticket, with its note", () => {
  const limiter = read("src/middleware/rate-limiter.ts");
  assert.match(limiter, /export function checkGenerationRateLimit/);
  assert.match(limiter, /NOT CALLED since 20\/10\/2026/);
});
