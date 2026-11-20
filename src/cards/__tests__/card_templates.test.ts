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

for (const card of CARDS) {
  const html = card.html();

  test(`${card.id}: no external URLs`, () => {
    // The only absolute URL shapes allowed are the https:// test inside a script regex.
    const urls = html.match(/\b(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'<>)]*/gi) ?? [];
    assert.deepEqual(urls, []);
    assert.doesNotMatch(html, /<script[^>]*\bsrc=/i);
    assert.doesNotMatch(html, /<link\b/i);
    assert.doesNotMatch(html, /@import|url\(/i);
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
    assert.doesNotMatch(html, /\bring\b|streak|<svg|<canvas|photo/i);
  });

  test(`${card.id}: at most two actions`, () => {
    const actions = html.match(/class="pc-btn\b/g) ?? [];
    assert.ok(actions.length <= 2, `${actions.length} actions`);
  });
}
