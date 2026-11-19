import { test } from "node:test";
import assert from "node:assert/strict";

import { runWithConnectorFacts } from "../../../connector/connector_use.js";
import {
  ENTRY_LINK_BODY,
  ENTRY_LINK_CALCULATORS,
  ENTRY_LINK_PROGRAM,
  ENTRY_LINK_SCAN,
  ENTRY_LINK_TRAIN,
  HANDOFF_ROUTES,
  HANDOFF_TTL_MS,
  hashHandoffToken,
  isHandoffRoute,
  mintSignedEntryLink,
  type HandoffTokenRecord,
} from "../entry_links.js";

const FAKE_UID = "synthetic_uid_0001";
const FAKE_PROFILE = "synthetic_profile_0001";
const FAKE_NOW_MS = 1_760_000_000_000;

test("preserves existing entry link constants and closed route list", () => {
  assert.equal(ENTRY_LINK_PROGRAM, "https://coach.pelaris.io/start/program");
  assert.equal(ENTRY_LINK_TRAIN, "https://coach.pelaris.io/start/train");
  assert.equal(ENTRY_LINK_SCAN, "https://coach.pelaris.io/start/scan");
  assert.equal(ENTRY_LINK_BODY, "https://coach.pelaris.io/start/body");
  assert.equal(ENTRY_LINK_CALCULATORS, "https://coach.pelaris.io/start/calculators");

  assert.deepEqual(HANDOFF_ROUTES, [
    "program",
    "train",
    "scan",
    "body",
    "calculators",
  ]);
  assert.equal(isHandoffRoute("plans"), false);
  assert.equal(isHandoffRoute("checkout"), false);
});

test("mints a signed link, stores only sha256(opaqueToken), and sets 10-minute TTL", async () => {
  const writes: Array<{ id: string; data: HandoffTokenRecord }> = [];
  const url = await mintSignedEntryLink(
    "scan",
    { uid: FAKE_UID, profile_id: FAKE_PROFILE },
    {
      nowMs: () => FAKE_NOW_MS,
      writeTokenDoc: async (id, data) => {
        writes.push({ id, data });
      },
    },
  );

  const parsed = new URL(url);
  assert.equal(parsed.origin, "https://coach.pelaris.io");
  assert.equal(parsed.pathname, "/start/scan");
  const opaque = parsed.searchParams.get("h");
  assert.ok(opaque && opaque.length === 43);

  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, hashHandoffToken(opaque));
  assert.equal(writes[0].id.includes(opaque), false);
  assert.equal(writes[0].data.uid, FAKE_UID);
  assert.equal(writes[0].data.profile_id, FAKE_PROFILE);
  assert.equal(writes[0].data.route, "scan");
  assert.equal(writes[0].data.issued_by, "connector");
  assert.equal(writes[0].data.consumed_at, null);
  assert.equal(writes[0].data.expire_at.toMillis(), FAKE_NOW_MS + HANDOFF_TTL_MS);
});

test("resolves uid from verified connector request facts when JWT claims carry profile_id only", async () => {
  const writes: Array<{ id: string; data: HandoffTokenRecord }> = [];
  const url = await runWithConnectorFacts(
    { uid: FAKE_UID, profileId: FAKE_PROFILE, clientClass: "chatgpt" },
    () =>
      mintSignedEntryLink(
        "body",
        { profile_id: FAKE_PROFILE },
        {
          nowMs: () => FAKE_NOW_MS,
          writeTokenDoc: async (id, data) => {
            writes.push({ id, data });
          },
        },
      ),
  );

  assert.match(url, /^https:\/\/coach\.pelaris\.io\/start\/body\?h=[A-Za-z0-9_-]{43}$/);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].data.uid, FAKE_UID);
  assert.equal(writes[0].data.profile_id, FAKE_PROFILE);
});

test("falls back cleanly to plain /start/<route> when claims lack uid/profile_id or Firestore fails", async () => {
  assert.equal(await mintSignedEntryLink("program", null), ENTRY_LINK_PROGRAM);
  assert.equal(
    await mintSignedEntryLink("train", { profile_id: FAKE_PROFILE }),
    ENTRY_LINK_TRAIN,
  );
  assert.equal(
    await mintSignedEntryLink("scan", { uid: FAKE_UID }),
    ENTRY_LINK_SCAN,
  );

  const onFailure = await mintSignedEntryLink(
    "body",
    { uid: FAKE_UID, profile_id: FAKE_PROFILE },
    {
      writeTokenDoc: async () => {
        throw new Error("simulated firestore outage");
      },
    },
  );
  assert.equal(onFailure, ENTRY_LINK_BODY);

  await assert.rejects(
    () => mintSignedEntryLink("plans" as never, { uid: FAKE_UID, profile_id: FAKE_PROFILE }),
    /Unsupported entry route/,
  );
});
