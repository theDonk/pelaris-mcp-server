/**
 * B2a C6 (a): the vendored redirect policy runs the case table it shares with
 * wayfinder, and both pin the same canonical digest (node:test; run after
 * build through `npm test`). Synthetic hosts only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { readFileSync } from "fs";

import {
  classifyRedirectUri,
  classifyRedirectUris,
  parseRedirectPolicy,
  REDIRECT_POLICY_CASES_SHA256,
} from "../redirect_policy.js";

const raw = readFileSync(new URL("../../../test_fixtures/redirect_policy_cases.json", import.meta.url), "utf8");
const table = JSON.parse(raw) as {
  uri_cases: Array<{ name: string; uri: string; pad_to?: number; custom_schemes: string[]; expect: { ok: boolean; kind?: string; reason?: string } }>;
  list_cases: Array<{ name: string; uris: unknown; custom_schemes: string[]; expect: { ok: boolean; reason?: string; index?: number | null } }>;
  dial_cases: Array<{ name: string; doc: Record<string, unknown> | null; expect_custom_schemes: string[] }>;
};

test("the case table's canonical digest equals wayfinder's", () => {
  const hash = crypto.createHash("sha256").update(JSON.stringify(JSON.parse(raw)), "utf8").digest("hex");
  assert.equal(hash, REDIRECT_POLICY_CASES_SHA256);
});

for (const c of table.uri_cases) {
  test(`uri: ${c.name}`, () => {
    const uri = c.pad_to ? c.uri + "a".repeat(c.pad_to - c.uri.length) : c.uri;
    const verdict = classifyRedirectUri(uri, { customSchemes: c.custom_schemes });
    assert.equal(verdict.ok, c.expect.ok);
    if (verdict.ok) assert.equal(verdict.kind, c.expect.kind);
    else assert.equal(verdict.reason, c.expect.reason);
  });
}

for (const c of table.list_cases) {
  test(`list: ${c.name}`, () => {
    const verdict = classifyRedirectUris(c.uris, { customSchemes: c.custom_schemes });
    assert.equal(verdict.ok, c.expect.ok);
    if (!verdict.ok) {
      assert.equal(verdict.reason, c.expect.reason);
      assert.equal(verdict.index, c.expect.index);
    }
  });
}

for (const c of table.dial_cases) {
  test(`dial: ${c.name}`, () => {
    assert.deepEqual([...parseRedirectPolicy(c.doc).policy.customSchemes], c.expect_custom_schemes);
  });
}
