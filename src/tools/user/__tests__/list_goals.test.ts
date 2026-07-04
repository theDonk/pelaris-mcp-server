/**
 * Registration + annotation tests for the list_goals MCP tool (node:test, no
 * extra dependencies). Run after build: node --test dist/tools/user/__tests__/
 *
 * list_goals is the read-only split-out of manage_goals (DESIGN.md Item 3): it
 * must register with read-only annotations so connector clients (and the cert
 * check) see a non-destructive read surface. These tests capture the exact
 * server.registerTool(...) registration config without invoking the
 * Firestore-backed handler.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerListGoals } from "../list_goals.js";

interface CapturedTool {
  name: string;
  title: string;
  description: string;
  schema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  handler: unknown;
}

function captureRegistration(): CapturedTool {
  let captured: CapturedTool | null = null;
  const fakeServer = {
    // Modern registerTool(name, config, handler) signature: the config object
    // carries the top-level `title` connector-cert reviewers read (precedence
    // title -> annotations.title -> name), mirrored into annotations.title.
    registerTool: (name: string, config: Record<string, unknown>, handler: unknown) => {
      captured = {
        name,
        title: config.title as string,
        description: config.description as string,
        schema: config.inputSchema as Record<string, unknown>,
        annotations: config.annotations as Record<string, unknown>,
        handler,
      };
    },
  };
  registerListGoals(fakeServer as unknown as Parameters<typeof registerListGoals>[0]);
  assert.ok(captured, "tool registration captured");
  return captured;
}

test("registers with the exact name and read-only annotations", () => {
  const tool = captureRegistration();
  assert.equal(tool.name, "list_goals");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.equal(tool.annotations.openWorldHint, false);
});

test("carries a top-level human title, mirrored into annotations", () => {
  const tool = captureRegistration();
  assert.ok(typeof tool.title === "string" && tool.title.length > 0, "top-level title is a non-empty string");
  assert.equal(tool.annotations.title, tool.title, "title mirrored into annotations as a fallback");
});
