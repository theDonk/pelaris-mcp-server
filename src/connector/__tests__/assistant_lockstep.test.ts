/**
 * PEL-1282 (node:test): the gateway's copies of the assistant closed sets.
 *
 * Twin: wayfinder `functions/src/__tests__/assistant_lockstep.test.ts` pins the same PINNED
 * literal below against C9's ASSISTANT_CLASSES and ASSISTANT_HOSTS; wayfinder's
 * `tools/check_gateway_contract_drift.mjs` (checks 4 and 4b) compares the two repos' sources.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MAPPED_ASSISTANT_HOSTS, dcrRefusedLine, uriNamesAssistantHost } from "../dcr_guard.js";
import { ASSISTANT_CLASSES, judgeTokenAccess } from "../token_access.js";

/** Byte-identical in the wayfinder twin. */
const PINNED = {
  classes: ["chatgpt", "claude", "grok", "gemini", "mistral", "cursor", "other"],
  hosts: [
    "anysphere.cursor-mcp", "callback.mistral.ai", "chat.openai.com", "chatgpt.com", "claude.ai", "claude.com",
    "grok.com", "oauth-redirect.googleusercontent.com", "www.cursor.com",
  ],
};

test("the classes and hosts equal the pinned literal (same as wayfinder)", () => {
  assert.deepEqual([...ASSISTANT_CLASSES], PINNED.classes);
  assert.deepEqual([...MAPPED_ASSISTANT_HOSTS].sort(), PINNED.hosts);
});

test("a refused registration naming any assistant host flags assistant_host, including Cursor's cursor:// host", () => {
  for (const host of PINNED.hosts) assert.equal(uriNamesAssistantHost(`https://${host}/x`), true, host);
  const cursor = dcrRefusedLine({ reason: "custom_scheme_not_listed", scheme: "cursor:", refusedUri: "cursor://anysphere.cursor-mcp/oauth/callback" });
  assert.equal(cursor.assistant_host, true);
  assert.equal(uriNamesAssistantHost("https://cursor.com.evil.example/x"), false);
  assert.equal(uriNamesAssistantHost("https://constructor/x"), false);
});

test("a token stamped with a new class reads that class; an unknown one reads null", async () => {
  const reader = (assistantClass: unknown) => ({
    getTokenDoc: async () => ({ uid: "uid_lockstep_1", profile_id: "uid_lockstep_1", assistant_class: assistantClass }),
    getProfile: async () => ({}),
  });
  const claims = { profile_id: "uid_lockstep_1" };
  for (const cls of ["grok", "gemini", "mistral", "cursor"]) {
    const verdict = await judgeTokenAccess("token_lockstep", claims, reader(cls));
    assert.equal(verdict.kind === "allow" ? verdict.assistantClass : verdict.kind, cls);
  }
  const unknown = await judgeTokenAccess("token_lockstep", claims, reader("perplexity"));
  assert.equal(unknown.kind === "allow" ? unknown.assistantClass : unknown.kind, null);
});
