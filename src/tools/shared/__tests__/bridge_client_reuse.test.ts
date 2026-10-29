/**
 * The bridge client reuses one ID-token client per target (MCP_FIXES.md §1.6, node:test), so the
 * return check and the tool's own bridge call share a cached token. No network.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { __resetIdTokenClientsForTest, idTokenClientFor } from "../bridge_client.js";

beforeEach(() => __resetIdTokenClientsForTest());

test("two calls to the same target create one client", async () => {
  let created = 0;
  const auth = { getIdTokenClient: async () => { created++; return { tag: created } as never; } };
  const a = await idTokenClientFor("https://example.test/coreToolsBridge", auth);
  const b = await idTokenClientFor("https://example.test/coreToolsBridge", auth);
  assert.equal(created, 1);
  assert.equal(a, b);
  await idTokenClientFor("https://example.test/other", auth);
  assert.equal(created, 2, "one per target");
});

test("a failed creation is forgotten, so the next call retries", async () => {
  let attempts = 0;
  const auth = {
    getIdTokenClient: async () => {
      attempts++;
      if (attempts === 1) throw new Error("metadata server unavailable");
      return {} as never;
    },
  };
  await assert.rejects(idTokenClientFor("https://example.test/coreToolsBridge", auth));
  await new Promise((resolve) => setImmediate(resolve));
  await idTokenClientFor("https://example.test/coreToolsBridge", auth);
  assert.equal(attempts, 2);
});
