/**
 * get_session_details names every source and its device: primary first, one row per provider and
 * device, null when no device is named. The same cases as the core tool's test in the wayfinder
 * repository. node:test, no Firestore.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionSourcesFromLinkedEntries } from "../session_sources.js";

test("every provider is named, primary first, de-duplicated, device null when absent", () => {
  const sources = sessionSourcesFromLinkedEntries([
    { provider: "strava", importedActivityId: "strava_1", isPrimary: false, actuals: {} },
    { provider: "garmin", importedActivityId: "garmin_42", deviceName: "Garmin Forerunner 965", isPrimary: true, actuals: {} },
    { provider: "polar", importedActivityId: "polar_7", deviceName: null, isPrimary: false, actuals: {} },
    { provider: "garmin", importedActivityId: "garmin_42", deviceName: "Garmin Forerunner 965", isPrimary: false, actuals: {} },
    { provider: "apple_health", importedActivityId: "apple_health_9", deviceName: "  ", isPrimary: false, actuals: {} },
    { importedActivityId: "broken", isPrimary: false },
  ]);
  assert.deepEqual(sources, [
    { provider: "garmin", deviceName: "Garmin Forerunner 965" },
    { provider: "strava", deviceName: null },
    { provider: "polar", deviceName: null },
    { provider: "apple_health", deviceName: null },
  ]);
});

test("a session with no synced source has an empty list", () => {
  assert.deepEqual(sessionSourcesFromLinkedEntries(undefined), []);
  assert.deepEqual(sessionSourcesFromLinkedEntries(null), []);
  assert.deepEqual(sessionSourcesFromLinkedEntries("garmin"), []);
  assert.deepEqual(sessionSourcesFromLinkedEntries([]), []);
});

test("the tool returns sources and tells the assistant it can name the source and device", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "..", "..", "..", "..", "src", "tools", "user", "get_session_details.ts"), "utf8");
  assert.match(source, /sources: sessionSourcesFromLinkedEntries\(d\.linked_imported_sources\)/);
  assert.match(source, /Garmin Forerunner 965/);
});
