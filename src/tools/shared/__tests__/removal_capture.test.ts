/**
 * Coach autonomy uplift, P7a: the gateway copies what it is about to remove (server-only, TTL), tells the
 * assistant what went, and no gateway tool can accept or write the autonomy switch. node:test, no Firestore.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RETENTION_DAYS,
  GATEWAY_CAPTURE_REQUESTED_BY,
  buildRemovalVersionRow,
  captureBeforeRemoval,
  describeRemoved,
} from "../removal_capture.js";

const session = {
  title: "Legs",
  scheduled_date: "2026-10-08",
  origin_queue_id: "q1",
  coach_note: { message: "private words" },
  blocks: [{ exercises: [{ exercise_name: "Back Squat" }, { name: "Lunge" }] }],
};

test("describeRemoved is closed facts: title, day, exercise names, never notes", () => {
  const d = describeRemoved(session);
  assert.deepEqual(d, { title: "Legs", scheduledDate: "2026-10-08", exerciseNames: ["Back Squat", "Lunge"] });
  assert.equal(JSON.stringify(d).includes("private words"), false);
});

test("the version row is namespaced, carries the copy and a TTL", () => {
  const now = Date.UTC(2026, 9, 20);
  const row = buildRemovalVersionRow({
    kind: "bulkDelete", sessionOrQueueId: "s1", queueId: "q1", previous: session,
    targetType: "diary_session", nowMs: now, retentionDays: 30,
  });
  assert.equal(row.requested_by, GATEWAY_CAPTURE_REQUESTED_BY.bulkDelete);
  assert.equal(row.requested_by, "mcp_bulk_delete");
  assert.equal(row.session_id, "s1");
  assert.equal(row.previous, session);
  assert.equal("retired" in row, false); // the return refresh keeps only retired return_refresh rows
  assert.equal((row.expires_at as Date).getTime() - now, 30 * 24 * 60 * 60 * 1000);
});

test("captureBeforeRemoval writes first and reports true; a failing write reports false and never throws", async () => {
  const rows: Array<Record<string, unknown>> = [];
  const ok = await captureBeforeRemoval(
    { profileId: "p1", kind: "delete", sessionOrQueueId: "s1", previous: session, targetType: "diary_session", nowMs: 1 },
    { write: async (_p, r) => { rows.push(r); }, retentionDays: async () => DEFAULT_RETENTION_DAYS },
  );
  assert.equal(ok, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].queue_id, "q1"); // the diary row's own origin queue

  const origWarn = console.warn;
  console.warn = () => undefined;
  try {
    const failed = await captureBeforeRemoval(
      { profileId: "p1", kind: "archive", sessionOrQueueId: "q9", queueId: "q9", previous: { status: "active" }, targetType: "queue" },
      { write: async () => { throw new Error("down"); }, retentionDays: async () => 30 },
    );
    assert.equal(failed, false);
  } finally {
    console.warn = origWarn;
  }
});

test("every removal tool calls the capture before it deletes", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const user = join(here, "..", "..", "user");
  // Connector rev 2.1 (22/10/2026): manage_program's archive is no longer a direct write that needs a copy
  // first. It goes through Pelaris's core tool, which asks the app's own Remove: that marks the program and
  // never deletes it, so the program stays whole. The `archive` kind in removal_capture.ts is kept, unused.
  // Deleting a session (one or many) still writes directly, so it still copies first.
  for (const file of ["delete_session"]) {
    const src = readFileSync(join(user, `${file}.js`), "utf8");
    assert.ok(src.includes("captureBeforeRemoval"), `${file} captures`);
    assert.ok(src.indexOf("captureBeforeRemoval(") < src.search(/\.(delete|update)\(/), `${file} captures before it writes`);
  }
});

test("no gateway tool accepts or writes the coach autonomy switch (invariant, design 3.5)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const tools = join(here, "..", "..");
  const offenders: string[] = [];
  for (const dir of ["user", "shared"]) {
    for (const f of readdirSync(join(tools, dir))) {
      if (!f.endsWith(".js")) continue;
      const text = readFileSync(join(tools, dir, f), "utf8");
      if (/coach_autonomy|autonomy_(mode|level|overrides)/i.test(text)) offenders.push(`${dir}/${f}`);
    }
  }
  assert.deepEqual(offenders, []);
});
