/**
 * Debrief card: the week's debrief as a share card, under get_weekly_debrief.
 *
 * Shows the week label, "N of M sessions" with a plain bar (never a ring), the bonus
 * line when there were bonus sessions, next week's focus and the tagline line.
 *
 * Headline win and one thing to watch: no stored field holds either, and choosing them
 * is a judgement, so this code does not pick them. The only line it shows is a single
 * fact stated as data: when the week has exactly one new record in `newPrs`, that
 * record, worded neutrally ("Back squat: 80, was 77.5"). Otherwise both lines are left
 * out and the assistant's own message carries the judgement.
 *
 * Actions: "Save as image" draws a square picture on a canvas inside the card (week,
 * sessions, the record line when shown, next week's focus, the tagline; no name, no
 * account details) and offers it as a download. If the host's frame blocks downloads,
 * the picture shows in the card and the action becomes "Copy text". "Open in Pelaris"
 * is the signed one-tap link to the program route.
 */

import type { HandoffRoute } from "../tools/shared/entry_links.js";
import type { CardDefinition } from "./card_shell.js";
import { renderCardPage } from "./templates.js";

/** Where "Open in Pelaris" lands. */
export const DEBRIEF_CARD_OPEN_ROUTE: HandoffRoute = "program";

/** The tagline line, exactly. */
export const DEBRIEF_CARD_TAGLINE = "Pelaris · Stop tracking. Start navigating.";

export interface DebriefCardData {
  weekLabel: string;
  sessionsLine: string;
  completed: number;
  planned: number;
  bonusLine: string | null;
  recordLine: string | null;
  focus: string | null;
  tagline: string;
  fileName: string;
  shareText: string;
  openUrl: string | null;
}

type Raw = Record<string, unknown>;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function plainNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/**
 * One new record as data, or null. The value carries no unit in the tool output, so
 * none is added; "was" is neutral for records where lower is better (times) too.
 */
export function recordLineFrom(newPrs: unknown): string | null {
  if (!Array.isArray(newPrs) || newPrs.length !== 1) return null;
  const pr = newPrs[0] as Raw | null;
  if (!pr || typeof pr !== "object") return null;
  const name = text(pr.exerciseName);
  if (!name || typeof pr.value !== "number" || !Number.isFinite(pr.value)) return null;
  const was = typeof pr.previousValue === "number" && Number.isFinite(pr.previousValue)
    ? `, was ${plainNumber(pr.previousValue)}`
    : "";
  return `New record: ${name} ${plainNumber(pr.value)}${was}`;
}

function fileNameFor(weekStarting: unknown): string {
  const m = typeof weekStarting === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(weekStarting) : null;
  return m ? `pelaris-week-${Number(m[3])}-${MONTHS[Number(m[2]) - 1]}.png` : "pelaris-week.png";
}

/**
 * Maps the get_weekly_debrief reply to the card's data. Returns null for the empty
 * week reply (a message, no metrics) and when there is nothing to show.
 */
export function buildDebriefCardData(result: Raw, openUrl: string | null): DebriefCardData | null {
  const metrics = result.metrics;
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return null;
  const m = metrics as Raw;
  const completed = count(m.sessionsCompleted);
  const planned = count(m.sessionsPlanned);
  const bonus = count(m.bonusSessions);
  const focus = text(result.nextWeekFocus);
  if (completed === 0 && planned === 0 && bonus === 0 && !focus) return null;

  const weekLabel = text(result.weekLabel) ?? "Your week";
  const sessionsLine = planned > 0
    ? `${completed} of ${planned} session${planned === 1 ? "" : "s"}`
    : `${completed} session${completed === 1 ? "" : "s"}`;
  const bonusLine = bonus > 0 ? `plus ${bonus} bonus session${bonus === 1 ? "" : "s"}` : null;
  const recordLine = recordLineFrom(m.newPrs);
  const shareText = [
    weekLabel,
    sessionsLine + (bonusLine ? `, ${bonusLine}` : ""),
    recordLine,
    focus ? `Next week: ${focus}` : null,
    DEBRIEF_CARD_TAGLINE,
  ].filter((x): x is string => !!x).join("\n");

  return {
    weekLabel,
    sessionsLine,
    completed,
    planned,
    bonusLine,
    recordLine,
    focus,
    tagline: DEBRIEF_CARD_TAGLINE,
    fileName: fileNameFor(result.weekStarting),
    shareText,
    openUrl,
  };
}

const DEBRIEF_CARD_CSS = `
.db-count{font-size:22px;font-weight:600;margin:10px 0 6px}
.db-bar{height:8px;border-radius:4px;background:var(--pc-bg-2);overflow:hidden}
.db-bar span{display:block;height:100%;width:0;background:var(--pc-accent);border-radius:4px}
.db-tag{font-size:12px;color:var(--pc-text-2);margin:12px 0 0}
.db-pic{display:block;width:100%;max-width:320px;height:auto;margin-top:10px;border-radius:8px}
`;

const DEBRIEF_CARD_BODY = `
<main class="pc-card" aria-live="polite">
  <h1 class="pc-title" id="week">Your week</h1>
  <p class="db-count" id="count"></p>
  <div class="db-bar" id="bar" role="img" aria-label=""><span id="bar-fill"></span></div>
  <p class="pc-sub" id="bonus"></p>
  <section id="record-section" class="pc-hidden">
    <h2 class="pc-sec">This week</h2>
    <p class="pc-line" id="record"></p>
  </section>
  <section id="focus-section" class="pc-hidden">
    <h2 class="pc-sec">Next week's focus</h2>
    <p class="pc-line" id="focus"></p>
  </section>
  <p class="db-tag" id="tagline"></p>
  <div id="pic-box"></div>
  <div class="pc-actions">
    <button type="button" class="pc-btn pc-btn-primary" id="save">Save as image</button>
    <a class="pc-btn pc-btn-secondary" id="open" href="#" target="_blank" rel="noopener noreferrer">Open in Pelaris</a>
  </div>
  <p class="pc-note" id="note" role="status"></p>
</main>
`;

const DEBRIEF_CARD_SCRIPT = `
(function(){
  "use strict";
  var card = window.PelarisCard;
  var $ = function(id){ return document.getElementById(id); };
  var d = null, copyMode = false;
  function text(id, v){ $(id).textContent = v || ""; }
  function show(id, on){ $(id).classList.toggle("pc-hidden", !on); }
  function note(t){ text("note", t); }
  function draw(data){
    d = data;
    text("week", d.weekLabel);
    text("count", d.sessionsLine);
    var hasBar = typeof d.planned === "number" && d.planned > 0;
    show("bar", hasBar);
    if (hasBar) {
      var pct = Math.max(0, Math.min(100, Math.round((d.completed / d.planned) * 100)));
      $("bar-fill").style.width = pct + "%";
      $("bar").setAttribute("aria-label", d.sessionsLine);
    }
    text("bonus", d.bonusLine); show("bonus", !!d.bonusLine);
    text("record", d.recordLine); show("record-section", !!d.recordLine);
    text("focus", d.focus); show("focus-section", !!d.focus);
    text("tagline", d.tagline);
    var open = $("open");
    if (typeof d.openUrl === "string" && /^https:\\/\\//.test(d.openUrl)) { open.setAttribute("href", d.openUrl); open.removeAttribute("aria-disabled"); }
    else { open.setAttribute("href", "#"); open.setAttribute("aria-disabled", "true"); }
  }

  function wrap(ctx, str, maxWidth){
    var words = String(str).split(/\\s+/), lines = [], line = "";
    words.forEach(function(w){
      var test = line ? line + " " + w : w;
      if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; } else { line = test; }
    });
    if (line) lines.push(line);
    return lines.slice(0, 3);
  }
  function picture(){
    var size = 1080, c = document.createElement("canvas");
    c.width = size; c.height = size;
    var x = c.getContext("2d"); if (!x) return null;
    var font = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    x.fillStyle = "#0d2238"; x.fillRect(0, 0, size, size);
    x.fillStyle = "#9cc9f0"; x.font = "600 44px " + font; x.textBaseline = "top";
    x.fillText("Pelaris \\u00b7 " + d.weekLabel, 90, 100);
    x.fillStyle = "#ffffff"; x.font = "700 120px " + font;
    x.fillText(d.sessionsLine, 90, 230);
    var y = 390;
    if (typeof d.planned === "number" && d.planned > 0) {
      x.fillStyle = "#24476b"; x.fillRect(90, y, 900, 24);
      x.fillStyle = "#2fa4ff"; x.fillRect(90, y, Math.round(900 * Math.min(1, d.completed / d.planned)), 24);
      y += 70;
    }
    x.fillStyle = "#d7e6f5"; x.font = "500 52px " + font;
    if (d.bonusLine) { x.fillText(d.bonusLine, 90, y); y += 90; }
    if (d.recordLine) { wrap(x, d.recordLine, 900).forEach(function(l){ x.fillText(l, 90, y); y += 66; }); y += 30; }
    if (d.focus) { wrap(x, "Next week: " + d.focus, 900).forEach(function(l){ x.fillText(l, 90, y); y += 66; }); }
    x.fillStyle = "#9cc9f0"; x.font = "600 44px " + font;
    x.fillText(d.tagline, 90, size - 150);
    return c;
  }
  function showPicture(url){
    var box = $("pic-box"); box.replaceChildren();
    var im = document.createElement("img"); im.className = "db-pic"; im.alt = d.shareText; im.src = url;
    box.append(im);
  }
  function copyText(){
    var t = d ? d.shareText : "";
    var done = function(ok){ note(ok ? "Copied." : "Select the text on the card to copy it."); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(function(){ done(true); }, function(){ done(fallbackCopy(t)); });
    } else done(fallbackCopy(t));
  }
  function fallbackCopy(t){
    try {
      var ta = document.createElement("textarea"); ta.value = t; ta.setAttribute("readonly", "");
      ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.append(ta); ta.select();
      var ok = document.execCommand("copy"); ta.remove(); return !!ok;
    } catch (e) { return false; }
  }
  $("save").addEventListener("click", function(){
    if (!d) return;
    if (copyMode) { copyText(); return; }
    var url = null;
    try { var c = picture(); url = c ? c.toDataURL("image/png") : null; } catch (e) { url = null; }
    if (url) {
      try {
        var a = document.createElement("a"); a.href = url; a.download = d.fileName || "pelaris-week.png";
        document.body.append(a); a.click(); a.remove();
      } catch (e) { /* the frame may block downloads */ }
      showPicture(url);
    }
    copyMode = true; $("save").textContent = "Copy text";
    note(url ? "If no file was saved, your chat app blocks downloads from cards: press and hold the picture, or copy the text." : "Your chat app cannot draw the picture here. Copy the text instead.");
  });
  $("open").addEventListener("click", function(ev){
    ev.preventDefault();
    if (!d || typeof d.openUrl !== "string" || !/^https:\\/\\//.test(d.openUrl)) { note("Open Pelaris to see your week."); return; }
    card.openLink(d.openUrl).then(function(ok){ if (!ok) note("Open Pelaris to see your week."); });
  });
  card.onData(draw);
})();
`;

export const DEBRIEF_CARD: CardDefinition = {
  id: "debrief",
  resourceUri: "ui://pelaris/cards/debrief-v1.html",
  title: "Pelaris weekly debrief card",
  description: "The week's debrief as a share card: sessions, next week's focus, Save as image and Open in Pelaris.",
  fields: {
    weekLabel: true,
    sessionsLine: true,
    completed: true,
    planned: true,
    bonusLine: true,
    recordLine: true,
    focus: true,
    tagline: true,
    fileName: true,
    shareText: true,
    openUrl: true,
  },
  html: () =>
    renderCardPage({
      title: "Pelaris weekly debrief",
      css: DEBRIEF_CARD_CSS,
      body: DEBRIEF_CARD_BODY,
      script: DEBRIEF_CARD_SCRIPT,
    }),
};
