/**
 * Registration + annotation tests for the list_goals MCP tool (node:test, no
 * extra dependencies). Run after build: node --test dist/tools/user/__tests__/
 *
 * list_goals is the read-only split-out of manage_goals (DESIGN.md Item 3): it
 * must register with read-only annotations so connector clients (and the cert
 * check) see a non-destructive read surface. These tests capture the exact
 * server.tool(...) registration args without invoking the Firestore-backed
 * handler.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerListGoals } from "../list_goals.js";

interface CapturedTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  handler: unknown;
}

function captureRegistration(): CapturedTool {
  let captured: CapturedTool | null = null;
  const fakeServer = {
    tool: (...args: unknown[]) => {
      captured = {
        name: args[0] as string,
        description: args[1] as string,
        schema: args[2] as Record<string, unknown>,
        annotations: args[3] as Record<string, unknown>,
        handler: args[4],
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

test("does not carry a title (titles are a separate pass)", () => {
  const tool = captureRegistration();
  assert.equal("title" in tool.annotations, false);
});
