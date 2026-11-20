/**
 * Debrief card: the week's debrief as a share card, under get_weekly_debrief.
 *
 * Shows the week label, "N of M sessions" with a plain bar (never a ring), the bonus
 * line when there were bonus sessions, next week's focus and the tagline line.
 *
 * Headline win and one thing to watch: no stored field holds either, and choosing them
 * is a judgement, so this code does not pick them; the assistant's own message carries
 * the judgement. What the card does show is every entry of `newPrs`, as plain data rows
 * under "New records" (exercise, value, the previous value when present; no unit, the
 * tool gives none). No cap and no pick: a long list makes the card taller (no nested
 * scroll inside the card), and an empty list shows no section. `newPrs` holds training
 * records only (exercise name, value, previous value, date), with no type field and no
 * body measurements, so nothing is filtered.
 *
 * Actions: "Save as image" draws a square picture on a canvas inside the card (week,
 * sessions, the first record rows that fit and "and N more" when cut, next week's focus,
 * the tagline; no name, no account details) and offers it as a download. If the host's frame blocks downloads,
 * the picture shows in the card and the action becomes "Copy text". "Open in Pelaris"
 * is the signed one-tap link to the program route.
 */

import type { HandoffRoute } from "../tools/shared/entry_links.js";
import { defineCard } from "./card_shell.js";

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
  /** Every new record, in the tool's order. Empty when there are none. */
  records: DebriefCardRecord[];
  focus: string | null;
  tagline: string;
  fileName: string;
  shareText: string;
  openUrl: string | null;
}

export interface DebriefCardRecord {
  exercise: string;
  /** The value as plain data, with the previous value when present ("80, was 77.5"). */
  value: string;
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
 * Every new record as a data row, in the tool's order. The value carries no unit in the
 * tool output, so none is added; "was" is neutral for records where lower is better
 * (times) too. An entry without a name or a numeric value is not a record and is left out.
 */
export function recordRowsFrom(newPrs: unknown): DebriefCardRecord[] {
  if (!Array.isArray(newPrs)) return [];
  const rows: DebriefCardRecord[] = [];
  for (const pr of newPrs as Array<Raw | null>) {
    if (!pr || typeof pr !== "object") continue;
    const exercise = text(pr.exerciseName);
    if (!exercise || typeof pr.value !== "number" || !Number.isFinite(pr.value)) continue;
    const was = typeof pr.previousValue === "number" && Number.isFinite(pr.previousValue)
      ? `, was ${plainNumber(pr.previousValue)}`
      : "";
    rows.push({ exercise, value: `${plainNumber(pr.value)}${was}` });
  }
  return rows;
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
  const records = recordRowsFrom(m.newPrs);
  const shareText = [
    weekLabel,
    sessionsLine + (bonusLine ? `, ${bonusLine}` : ""),
    records.length ? "New records:" : null,
    ...records.map((r) => `${r.exercise}: ${r.value}`),
    focus ? `Next week: ${focus}` : null,
    DEBRIEF_CARD_TAGLINE,
  ].filter((x): x is string => !!x).join("\n");

  return {
    weekLabel,
    sessionsLine,
    completed,
    planned,
    bonusLine,
    records,
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
    <h2 class="pc-sec">New records</h2>
    <ul class="pc-rows" id="records"></ul>
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
    var recs = Array.isArray(d.records) ? d.records : [];
    var list = $("records"); list.replaceChildren();
    recs.forEach(function(r){
      var li = document.createElement("li"); li.className = "pc-row";
      var a = document.createElement("span"); a.textContent = r.exercise;
      var b = document.createElement("span"); b.textContent = r.value;
      li.append(a, b); list.append(li);
    });
    show("record-section", recs.length > 0);
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
  function fit(ctx, str, maxWidth){
    var t = String(str);
    if (ctx.measureText(t).width <= maxWidth) return t;
    while (t.length > 1 && ctx.measureText(t + "...").width > maxWidth) t = t.slice(0, -1);
    return t + "...";
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
    var focusLines = d.focus ? wrap(x, "Next week: " + d.focus, 900) : [];
    var recs = Array.isArray(d.records) ? d.records : [];
    if (recs.length) {
      // The first rows that fit above the focus and the tagline, then "and N more".
      var bottom = size - 190 - focusLines.length * 66 - (focusLines.length ? 30 : 0);
      var room = Math.max(0, Math.floor((bottom - y - 50) / 50));
      var shown = recs.length <= room ? recs.length : Math.max(0, room - 1);
      x.font = "600 36px " + font; x.fillText("New records", 90, y); y += 50;
      x.font = "500 40px " + font;
      recs.slice(0, shown).forEach(function(r){ x.fillText(fit(x, r.exercise + ": " + r.value, 900), 90, y); y += 50; });
      if (shown < recs.length) { x.fillText("and " + (recs.length - shown) + " more", 90, y); y += 50; }
      y += 30; x.font = "500 52px " + font;
    }
    focusLines.forEach(function(l){ x.fillText(l, 90, y); y += 66; });
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

export const DEBRIEF_CARD = defineCard<DebriefCardData>({
  id: "debrief",
  v: 1,
  title: "Pelaris weekly debrief card",
  description: "The week's debrief as a share card: sessions, next week's focus, Save as image and Open in Pelaris.",
  fields: {
    weekLabel: true,
    sessionsLine: true,
    completed: true,
    planned: true,
    bonusLine: true,
    records: { exercise: true, value: true },
    focus: true,
    tagline: true,
    fileName: true,
    shareText: true,
    openUrl: true,
  },
  page: {
    title: "Pelaris weekly debrief",
    css: DEBRIEF_CARD_CSS,
    body: DEBRIEF_CARD_BODY,
    script: DEBRIEF_CARD_SCRIPT,
  },
});
