/**
 * Static checks on every card page (node:test). Run after build.
 *
 * Proves: no external URLs (no CDN, fonts or remote scripts), no inline event handler
 * attributes or javascript: URLs, no innerHTML or eval in the scripts, a strict CSP meta,
 * the 44 px tap target, light and dark, and no ring, streak or photo markup.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const { CARDS } = await import("../registry.js");

/**
 * Cards allowed one inline SVG diagram (the Body card's schematic outline). Their SVG may
 * hold only plain shapes: no links, no embedded images or documents, no styles that load.
 */
const INLINE_SVG_CARDS = new Set(["body"]);

for (const card of CARDS) {
  const html = card.html();

  test(`${card.id}: no external URLs`, () => {
    // The only absolute URL shapes allowed are the https:// test inside a script regex.
    const urls = html.match(/\b(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'<>)]*/gi) ?? [];
    assert.deepEqual(urls, []);
    assert.doesNotMatch(html, /<script[^>]*\bsrc=/i);
    assert.doesNotMatch(html, /<link\b/i);
    // CSS may not load anything: no @import and no url() in the styles.
    const styles = (html.match(/<style>[\s\S]*?<\/style>/g) ?? []).join("\n");
    assert.doesNotMatch(styles, /@import|url\(/i);
    assert.doesNotMatch(html, /@import/i);
    assert.doesNotMatch(html, /<(iframe|img|video|audio|object|embed)\b/i);
  });

  test(`${card.id}: no inline event handlers or javascript: URLs`, () => {
    assert.doesNotMatch(html, /<[a-z][^>]*\son[a-z]+\s*=/i);
    assert.doesNotMatch(html, /javascript:/i);
    assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
  });

  test(`${card.id}: strict CSP meta`, () => {
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1] ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /frame-src 'none'/);
    assert.doesNotMatch(csp, /https?:|\*/);
  });

  test(`${card.id}: 44 px tap targets, light and dark, host tokens`, () => {
    assert.match(html, /\.pc-btn\{[^}]*min-height:44px/);
    assert.match(html, /prefers-color-scheme: dark/);
    assert.match(html, /\[data-theme="dark"\]/);
    assert.match(html, /var\(--color-background-primary/);
  });

  test(`${card.id}: no ring, streak or photo`, () => {
    assert.doesNotMatch(html, /\bring\b|streak|<canvas|photo/i);
    if (!INLINE_SVG_CARDS.has(card.id)) {
      assert.doesNotMatch(html, /<svg/i);
      return;
    }
    const svgs = html.match(/<svg\b[\s\S]*?<\/svg>/gi) ?? [];
    assert.equal(svgs.length, 1, "one inline diagram");
    assert.equal((html.match(/<svg\b/gi) ?? []).length, 1);
    for (const svg of svgs) {
      assert.doesNotMatch(svg, /href|xmlns|<(image|use|foreignObject|script|style|a|text)\b|url\(|https?:/i);
      const tags = (svg.match(/<\/?([a-z]+)/gi) ?? []).map((t) => t.replace(/[</]/g, "").toLowerCase());
      assert.ok(tags.every((t) => ["svg", "path", "circle"].includes(t)), tags.join(","));
    }
  });

  test(`${card.id}: at most two actions inline`, () => {
    // Markup between <!--full--> and <!--/full--> shows only in full screen.
    const inline = html.replace(/<!--full-->[\s\S]*?<!--\/full-->/g, "");
    const actions = inline.match(/class="pc-btn\b/g) ?? [];
    assert.ok(actions.length <= 2, `${actions.length} actions`);
  });
}

// The data contract: each page draws only its own card id and data version.
const { CARD_FALLBACK_LINE } = await import("../templates.js");
const { CARD_DATA_META_KEY } = await import("../card_shell.js");
const { openCardPage } = await import("./card_dom_harness.js");

for (const card of CARDS) {
  for (const [why, payload] of [
    ["a wrong v", { card: card.id, v: card.v + 1, data: { title: "Garbage" } }],
    ["another card's id", { card: `${card.id}-other`, v: card.v, data: { title: "Garbage" } }],
    ["no envelope at all (the old flat shape)", { card: card.id, title: "Garbage" }],
  ] as const) {
    test(`${card.id} page: ${why} draws nothing but the fallback line`, async () => {
      const page = await openCardPage(card.html(), { host: () => ({ result: {} }) });
      page.notify("ui/notifications/tool-result", { _meta: { [CARD_DATA_META_KEY]: payload } });
      await page.settle();
      const main = page.body.all().find((e) => e.tagName === "MAIN");
      assert.ok(main, "the card's main element");
      assert.deepEqual(main.children.map((c) => c.textContent), [CARD_FALLBACK_LINE]);
      assert.ok(!JSON.stringify(page.body.all().map((e) => e.textContent)).includes("Garbage"));
    });
  }
}
