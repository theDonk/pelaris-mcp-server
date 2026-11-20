/**
 * Page tests for what the host says: the display modes it offers, the mode it actually
 * set, and an isError answer to ui/message. Real bridge and card scripts in the vm
 * harness with a stub host. All data is made up.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const { WEEK_CARD, buildWeekCardData } = await import("../week_card.js");
const { BODY_CARD, buildBodyCardData } = await import("../body_card.js");
const { bodyAnalysisFromCore } = await import("../../tools/user/get_body_analysis.js");
const { openCardPage } = await import("./card_dom_harness.js");
type HostReply = import("./card_dom_harness.js").HostReply;
type CardPage = import("./card_dom_harness.js").CardPage;

const weekData = () =>
  buildWeekCardData(
    {
      primaryProgramId: "queue_sample",
      today: "2026-11-26",
      programs: [
        {
          programId: "queue_sample",
          kind: "program",
          weekStartsOn: "2026-11-23",
          currentWeekSessions: [{ sessionId: "s1", focus: "Tempo run", scheduledDate: "2026-11-26", isCompleted: false }],
        },
      ],
    },
    "https://example.test/open",
  )!;

const bodyData = () =>
  buildBodyCardData(
    bodyAnalysisFromCore(
      {
        analyzedAt: "2026-11-15T08:00:00.000Z",
        source: "scan",
        measurements: { weightKg: 75, waistCm: 82, hipsCm: 98, shouldersCm: 118, heightCm: 178 },
        ratios: { shoulderToWaist: 1.439 },
        areasOfFocus: [],
        comparisonToPrevious: {
          previousAnalyzedAt: "2026-10-25T08:00:00.000Z",
          changes: { waistCm: { value: -1.5, direction: "down" }, hipsCm: { value: -0.5, direction: "down" } },
        },
      },
      "https://example.test/scan",
    ),
    "https://example.test/scan",
  )!;

const calls = (page: CardPage, method: string) => page.sent.filter((m) => m.method === method);

async function load(html: string, data: unknown, hostContext: Record<string, unknown>, host: (m: string, p: Record<string, unknown>) => HostReply) {
  const page = await openCardPage(html, { host, hostContext });
  page.notify("ui/notifications/tool-result", { _meta: { "pelaris/card": data } });
  await page.settle();
  return page;
}

const INLINE_ONLY = { availableDisplayModes: ["inline"], displayMode: "inline" };
const BOTH = { availableDisplayModes: ["inline", "fullscreen"], displayMode: "inline" };

test("week: the host kept the card inline (mode returned is inline), so the card says so and moves in place", async () => {
  const page = await load(WEEK_CARD.html(), weekData(), BOTH, (m) =>
    m === "ui/request-display-mode" ? { result: { mode: "inline" } } : { result: {} },
  );
  assert.equal(page.$("rearrange").textContent, "Rearrange this week");
  page.$("rearrange").click();
  await page.settle();
  assert.equal(page.$("note").textContent, "Rearranging here. Your chat app kept the card in place.");
  assert.ok(page.$("full-view").shown);
  page.$("done").click();
  await page.settle();
  assert.equal(calls(page, "ui/request-display-mode").length, 1, "no requestInline for a card that never left inline");
});

test("week: full screen not offered, so the first action is Move a session and opens the picker in the card", async () => {
  const page = await load(WEEK_CARD.html(), weekData(), INLINE_ONLY, () => ({ result: {} }));
  assert.equal(page.$("rearrange").textContent, "Move a session");
  page.$("rearrange").click();
  await page.settle();
  assert.equal(calls(page, "ui/request-display-mode").length, 0, "no full screen request");
  assert.ok(page.$("full-view").shown, "the move view opens in the card");
  const move = page.body.all().find((e) => e.classList.contains("wk-move"));
  assert.ok(move);
  move.click();
  assert.ok(page.$("picker").shown, "the day picker opens inline");
});

test("week: host-context-changed that offers full screen brings Rearrange back", async () => {
  const page = await load(WEEK_CARD.html(), weekData(), INLINE_ONLY, () => ({ result: {} }));
  assert.equal(page.$("rearrange").textContent, "Move a session");
  page.notify("ui/notifications/host-context-changed", { availableDisplayModes: ["inline", "fullscreen"] });
  await page.settle();
  assert.equal(page.$("rearrange").textContent, "Rearrange this week");
});

test("body: Compare scans shows only where the host offers full screen", async () => {
  const off = await load(BODY_CARD.html(), bodyData(), INLINE_ONLY, () => ({ result: {} }));
  assert.equal(off.$("compare").shown, false, "hidden without full screen");
  off.notify("ui/notifications/host-context-changed", { availableDisplayModes: ["inline", "fullscreen"] });
  await off.settle();
  assert.equal(off.$("compare").shown, true, "shown once the host offers it");
  const on = await load(BODY_CARD.html(), bodyData(), BOTH, () => ({ result: {} }));
  assert.equal(on.$("compare").shown, true);
});

test("ui/message with isError: the card shows a note instead of assuming it was sent", async () => {
  const page = await load(WEEK_CARD.html(), weekData(), BOTH, (m, p) => {
    if (m === "ui/request-display-mode") return { result: { mode: p.mode } };
    if (m === "tools/call") return { error: { code: -32601, message: "Method not found" } };
    if (m === "ui/message") return { result: { isError: true } };
    return { result: {} };
  });
  page.$("rearrange").click();
  await page.settle();
  page.body.all().find((e) => e.classList.contains("wk-move"))!.click();
  page.$("picker-days").children[0].click();
  page.$("confirm-yes").click();
  await page.settle();
  assert.equal(calls(page, "ui/message").length, 1, "the move went to the chat once (no tool call path)");
  assert.equal(page.$("note").textContent, "Ask in the chat to move this session.");
});
