/**
 * Body card data mapping tests (node:test). Run after build. All data is made up.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const { CARD_DATA_META_KEY } = await import("../card_shell.js");
const { CARD_BASE_CSS } = await import("../templates.js");
const { BODY_CARD, BODY_CARD_ESTIMATE_LINE, buildBodyCardData } = await import("../body_card.js");
const { bodyAnalysisFromCore, withBodyCard } = await import("../../tools/user/get_body_analysis.js");

const LINK = "https://example.invalid/scan";

const core = (extra: Record<string, unknown> = {}) => ({
  analyzedAt: "2026-11-15T08:00:00.000Z",
  source: "scan",
  measurements: { weightKg: 75, waistCm: 82, hipsCm: 98, shouldersCm: 118, heightCm: 178 },
  ratios: { shoulderToWaist: 1.439 },
  areasOfFocus: [],
  ...extra,
});

const comparison = {
  previousAnalyzedAt: "2026-10-25T08:00:00.000Z",
  changes: {
    weightKg: { value: -0.5, direction: "down" },
    waistCm: { value: -1.5, direction: "down" },
    hipsCm: { value: -0.5, direction: "down" },
    shouldersCm: { value: 0.5, direction: "up" },
  },
};

test("history of three: one stop per scan, oldest first; inline changes from the comparison", () => {
  const result = bodyAnalysisFromCore(
    core({
      comparisonToPrevious: comparison,
      history: [
        { analyzedAt: "2026-11-15T08:00:00.000Z", weightKg: 75, waistCm: 82, hipsCm: 98, shouldersCm: 118 },
        { analyzedAt: "2026-10-25T08:00:00.000Z", weightKg: 75.5, waistCm: 83.5, hipsCm: 98.5, shouldersCm: 117.5 },
        { analyzedAt: "2026-10-04T08:00:00.000Z", waistCm: 84, hipsCm: 99 },
      ],
    }),
    LINK,
  );
  const data = buildBodyCardData(result, LINK);
  assert.ok(data);
  assert.equal(data.dateLabel, "Sun 15 Nov");
  assert.equal(data.previousLabel, "Sun 25 Oct");
  assert.equal(data.derived, false);
  assert.deepEqual(data.stops.map((s) => s.dateLabel), ["Sun 4 Oct", "Sun 25 Oct", "Sun 15 Nov"]);
  assert.deepEqual(data.stops[0], { dateLabel: "Sun 4 Oct", waistCm: 84, hipsCm: 99, shouldersCm: null, weightKg: null });
  assert.deepEqual(data.rows, [
    { key: "waistCm", label: "Waist", value: 82, change: -1.5 },
    { key: "hipsCm", label: "Hips", value: 98, change: -0.5 },
    { key: "shouldersCm", label: "Shoulders", value: 118, change: 0.5 },
  ]);
  assert.equal(data.shoulderToWaist, 1.44);
  assert.equal(data.estimateLine, BODY_CARD_ESTIMATE_LINE);
  assert.equal(data.lengthUnit, "cm");
  assert.equal(data.weightUnit, "kg");
  assert.equal(data.openUrl, LINK);
});

test("no history with a comparison: two stops, the earlier one is the latest minus the change", () => {
  const data = buildBodyCardData(bodyAnalysisFromCore(core({ comparisonToPrevious: comparison }), LINK), LINK);
  assert.ok(data);
  assert.equal(data.derived, true);
  assert.deepEqual(data.stops, [
    { dateLabel: "Sun 25 Oct", waistCm: 83.5, hipsCm: 98.5, shouldersCm: 117.5, weightKg: 75.5 },
    { dateLabel: "Sun 15 Nov", waistCm: 82, hipsCm: 98, shouldersCm: 118, weightKg: 75 },
  ]);
});

test("a single scan with no comparison: one stop, no changes, no previous date", () => {
  const data = buildBodyCardData(bodyAnalysisFromCore(core(), LINK), LINK);
  assert.ok(data);
  assert.equal(data.stops.length, 1);
  assert.equal(data.previousLabel, null);
  assert.ok(data.rows.every((r) => r.change === null));
});

test("missing measurements: only the ones returned; none of the three means no card", () => {
  const some = buildBodyCardData(
    bodyAnalysisFromCore(core({ measurements: { waistCm: 80 }, ratios: {} }), LINK),
    null,
  );
  assert.ok(some);
  assert.deepEqual(some.rows.map((r) => r.label), ["Waist"]);
  assert.equal(some.shoulderToWaist, null);
  assert.equal(some.openUrl, null, "no link, no button");

  const profileOnly = bodyAnalysisFromCore(
    { analyzedAt: "2026-11-15T08:00:00.000Z", source: "profile", measurements: { weightKg: 70, heightCm: 170 } },
    LINK,
  );
  assert.equal(buildBodyCardData(profileOnly, LINK), null);
  assert.equal(buildBodyCardData({ analysis: null, message: "No body analysis data found" }, LINK), null);
});

test("bad types are dropped: strings, negatives, objects, bad dates and links", () => {
  const data = buildBodyCardData(
    {
      analyzedAt: "2026-11-15T08:00:00.000Z",
      measurements: { waistCm: "82", hipsCm: -3, shouldersCm: { v: 1 }, weightKg: 75 },
      comparisonToPrevious: { previousAnalyzedAt: "yesterday", changes: { waistCm: "big" } },
      history: [{ analyzedAt: 12, waistCm: 80 }, "x"],
    },
    "javascript:alert(1)",
  );
  assert.equal(data, null, "no usable waist, hips or shoulders");

  const ok = buildBodyCardData(
    {
      analyzedAt: "2026-11-15T08:00:00.000Z",
      measurements: { waistCm: 82, hipsCm: "98" },
      comparisonToPrevious: { previousAnalyzedAt: "nope", changes: { waistCm: { value: "1", direction: "up" } } },
    },
    "http://example.invalid/plain",
  );
  assert.ok(ok);
  assert.deepEqual(ok.rows, [{ key: "waistCm", label: "Waist", value: 82, change: null }]);
  assert.equal(ok.previousLabel, null);
  assert.equal(ok.stops.length, 1);
  assert.equal(ok.openUrl, null, "https links only");
});

test("the tool reply's text is unchanged; card data rides in _meta and passes the allow-list", () => {
  const result = bodyAnalysisFromCore(core({ comparisonToPrevious: comparison, assessment: "Private assessment text." }), LINK);
  const text = JSON.stringify(result, null, 2);
  const reply = withBodyCard({ content: [{ type: "text", text }] }, result);
  assert.equal(reply.content[0].text, text);
  const meta = reply._meta?.[CARD_DATA_META_KEY] as Record<string, unknown>;
  assert.equal(meta.card, BODY_CARD.id);
  const flat = JSON.stringify(meta);
  assert.ok(!flat.includes("Private assessment"), "the card never gets the assessment");
  assert.ok(!/photo|image|img/i.test(flat), "nothing image-shaped");
  assert.deepEqual(Object.keys(meta).sort(), ["card", ...Object.keys(BODY_CARD.fields)].sort());
});

test("no analysis means no card, and the reply is untouched", () => {
  const empty = { analysis: null, message: "No body analysis data found", scanLink: LINK };
  const reply = { content: [{ type: "text" as const, text: JSON.stringify(empty) }] };
  assert.equal(withBodyCard(reply, empty), reply);
});

test("card copy: never a record, best or win; the estimate line exactly", () => {
  const html = BODY_CARD.html();
  assert.doesNotMatch(html, /\b(record|best|win|winning|goal|ideal|great|well done|progress)\b/i);
  // No colour of its own: the shared tokens and the calm accent only, never red or green.
  const own = html.replace(CARD_BASE_CSS, "");
  assert.doesNotMatch(own, /#[0-9a-f]{3,8}\b|rgb\(|hsl\(|\b(red|green)\b/i);
  assert.equal(BODY_CARD_ESTIMATE_LINE, "Measurements are estimates from the scan, not exact.");
  assert.doesNotMatch(html, /<img\b/i);
});
