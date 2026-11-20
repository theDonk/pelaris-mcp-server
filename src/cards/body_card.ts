/**
 * Body card: compare body scans, under get_body_analysis.
 *
 * Inline: the latest scan's date; waist, hips and shoulders with the change since the
 * previous scan; the shoulder-to-waist ratio when the tool returned it; and two actions:
 * "Compare scans" (asks the host for full screen) and "Open in Pelaris" (the tool's own
 * signed scan link; no link, no button).
 *
 * Full screen: a slider with one stop per scan, oldest at the left and newest at the
 * right. With the tool's `history` there is a stop per scan in it; without it, two stops:
 * the latest values and the previous scan's values worked out as the latest minus the
 * change. Rows show waist, hips, shoulders and weight (when present) at the slider's
 * stop, each with its change since the first stop.
 *
 * The figure is a plain schematic outline in inline SVG (no face, no detail) whose
 * shoulder, waist and hip widths follow the three numbers at the slider's stop, clamped
 * so odd data cannot draw something absurd. It is a diagram, drawn from numbers only.
 *
 * Tone: body numbers are never records, bests or wins, and no colour judges a change.
 * Changes are plain signed numbers with the unit. Units: centimetres and kilograms
 * (the tool carries no unit preference).
 */

import type { CardDefinition } from "./card_shell.js";
import { renderCardPage } from "./templates.js";
import { weekDateLabel } from "./week_card.js";

/** The line every view of the card shows, exactly. */
export const BODY_CARD_ESTIMATE_LINE = "Measurements are estimates from the scan, not exact.";

export interface BodyCardRow {
  key: "waistCm" | "hipsCm" | "shouldersCm";
  label: string;
  value: number;
  /** Change since the previous scan (newer minus older), or null when not known. */
  change: number | null;
}

export interface BodyCardStop {
  dateLabel: string;
  waistCm: number | null;
  hipsCm: number | null;
  shouldersCm: number | null;
  weightKg: number | null;
}

export interface BodyCardData {
  dateLabel: string;
  previousLabel: string | null;
  lengthUnit: "cm";
  weightUnit: "kg";
  rows: BodyCardRow[];
  shoulderToWaist: number | null;
  /** Oldest first: the slider's stops. One stop means there is nothing to compare yet. */
  stops: BodyCardStop[];
  /** True when the earlier stop was worked out from the latest values and the changes. */
  derived: boolean;
  estimateLine: string;
  openUrl: string | null;
}

type Raw = Record<string, unknown>;

const KEYS = ["waistCm", "hipsCm", "shouldersCm"] as const;
const LABELS: Record<(typeof KEYS)[number], string> = { waistCm: "Waist", hipsCm: "Hips", shouldersCm: "Shoulders" };
const STOP_KEYS = ["waistCm", "hipsCm", "shouldersCm", "weightKg"] as const;

function obj(v: unknown): Raw | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null;
}

function positive(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v * 10) / 10 : null;
}

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
}

/** "2026-11-15T08:00:00Z" to "Sun 15 Nov", or null. */
function dateLabel(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(m[3])) return null;
  return weekDateLabel(`${m[1]}-${m[2]}-${m[3]}`);
}

/** A change from comparisonToPrevious: `{ value, direction }`, or a plain number. */
function changeValue(v: unknown): number | null {
  const o = obj(v);
  return o ? finite(o.value) : finite(v);
}

function stopFrom(label: string, values: Raw): BodyCardStop {
  return {
    dateLabel: label,
    waistCm: positive(values.waistCm),
    hipsCm: positive(values.hipsCm),
    shouldersCm: positive(values.shouldersCm),
    weightKg: positive(values.weightKg),
  };
}

function hasAny(stop: BodyCardStop): boolean {
  return STOP_KEYS.some((k) => stop[k] != null);
}

/**
 * Maps the get_body_analysis reply to the card's data. Returns null when the reply has no
 * analysis or none of waist, hips and shoulders (for example a profile weight only), so the
 * tool replies as text only. Pure (exported for tests).
 */
export function buildBodyCardData(result: Raw, openUrl: string | null): BodyCardData | null {
  const m = obj(result.measurements);
  const latestLabel = dateLabel(result.analyzedAt);
  if (!m || !latestLabel) return null;

  const comparison = obj(result.comparisonToPrevious);
  const changes = obj(comparison?.changes) ?? {};
  const previousLabel = dateLabel(comparison?.previousAnalyzedAt);

  // Stops, oldest first.
  let stops: BodyCardStop[] = [];
  let derived = false;
  const history = Array.isArray(result.history) ? result.history.map(obj).filter((e): e is Raw => e != null) : [];
  for (const e of history) {
    const label = dateLabel(e.analyzedAt);
    if (!label) continue;
    const stop = stopFrom(label, e);
    if (hasAny(stop)) stops.unshift(stop);
  }
  if (stops.length < 2) {
    const latest = stopFrom(latestLabel, m);
    stops = [latest];
    if (previousLabel) {
      const earlier: BodyCardStop = { dateLabel: previousLabel, waistCm: null, hipsCm: null, shouldersCm: null, weightKg: null };
      for (const k of STOP_KEYS) {
        const now = latest[k];
        const ch = changeValue(changes[k]);
        if (now != null && ch != null) earlier[k] = positive(now - ch);
      }
      if (hasAny(earlier)) {
        stops = [earlier, latest];
        derived = true;
      }
    }
  }

  // Inline rows: the latest values with the change since the previous scan. The server's own
  // comparison first; else the two newest history entries.
  const newest = history[0] ?? null;
  const second = history[1] ?? null;
  const rows: BodyCardRow[] = [];
  for (const k of KEYS) {
    const value = positive(m[k]);
    if (value == null) continue;
    let change = changeValue(changes[k]);
    if (change == null && newest && second) {
      const a = positive(newest[k]);
      const b = positive(second[k]);
      if (a != null && b != null) change = Math.round((a - b) * 10) / 10;
    }
    rows.push({ key: k, label: LABELS[k], value, change });
  }
  if (rows.length === 0) return null;

  const ratios = obj(result.ratios) ?? {};
  const historyPrevious = second ? dateLabel(second.analyzedAt) : null;
  return {
    dateLabel: latestLabel,
    previousLabel: previousLabel ?? historyPrevious,
    lengthUnit: "cm",
    weightUnit: "kg",
    rows,
    shoulderToWaist: positive(ratios.shoulderToWaist) != null ? Math.round((ratios.shoulderToWaist as number) * 100) / 100 : null,
    stops,
    derived,
    estimateLine: BODY_CARD_ESTIMATE_LINE,
    openUrl: typeof openUrl === "string" && /^https:\/\//.test(openUrl) ? openUrl : null,
  };
}

const BODY_CARD_CSS = `
.bd-rows{list-style:none;margin:10px 0 0;padding:0}
.bd-row{display:flex;align-items:baseline;gap:10px;padding:8px 0;border-top:1px solid var(--pc-line);font-size:14px}
.bd-row .bd-name{flex:1 1 auto;min-width:0}
.bd-row .bd-val{font-weight:600;white-space:nowrap}
.bd-row .bd-ch{color:var(--pc-text-2);font-size:12.5px;white-space:nowrap;min-width:84px;text-align:right}
.bd-wrap{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:6px}
.bd-fig{flex:0 0 auto;width:136px;height:170px;display:block}
.bd-fig path,.bd-fig circle{fill:none;stroke-linejoin:round;stroke-linecap:round}
.bd-fig .bd-now{stroke:var(--pc-accent);stroke-width:2.5}
.bd-fig .bd-ghost{stroke:var(--pc-line-2);stroke-width:1.5;stroke-dasharray:4 4}
.bd-side{flex:1 1 160px;min-width:0}
.bd-slide{margin:12px 0 0}
.bd-slide input{width:100%;min-height:44px;margin:0;accent-color:var(--pc-accent);cursor:pointer}
.bd-slide input:focus-visible{outline:2px solid var(--pc-accent);outline-offset:2px}
.bd-ends{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--pc-text-2)}
.bd-at{font-size:15px;font-weight:600;margin:4px 0 0}
.bd-steps{display:flex;gap:8px;margin-top:8px}
.bd-steps button{flex:1 1 0;min-height:44px;border-radius:var(--pc-radius-sm);border:1px solid var(--pc-line-2);
  background:transparent;color:var(--pc-text);font:500 13.5px/1.2 var(--pc-font);cursor:pointer}
.bd-steps button:focus-visible{outline:2px solid var(--pc-accent);outline-offset:2px}
.bd-steps button:disabled{opacity:.45;cursor:default}
`;

// The figure is static markup: the script only sets each path's `d` from the numbers.
const BODY_FIGURE = `
<svg class="bd-fig" viewBox="0 0 120 150" role="img" aria-label="A simple outline drawn from the measurements">
  <path class="bd-ghost" id="fig-ghost" d=""></path>
  <circle class="bd-now" cx="60" cy="14" r="9"></circle>
  <path class="bd-now" id="fig-now" d=""></path>
</svg>`;

const BODY_CARD_BODY = `
<main class="pc-card" aria-live="polite">
  <div class="pc-head">
    <h1 class="pc-title">Your body</h1>
    <span class="pc-meta" id="date"></span>
  </div>
  <p class="pc-sub" id="since"></p>
  <section id="inline-view">
    <ul class="bd-rows" id="rows"></ul>
    <p class="pc-sub" id="ratio"></p>
    <div class="pc-actions">
      <button type="button" class="pc-btn pc-btn-primary" id="compare">Compare scans</button>
      <a class="pc-btn pc-btn-secondary" id="open" href="#" target="_blank" rel="noopener noreferrer">Open in Pelaris</a>
    </div>
  </section>
  <!--full-->
  <section id="full-view" class="pc-hidden">
    <div class="bd-wrap">
      ${BODY_FIGURE}
      <div class="bd-side">
        <p class="bd-at" id="at"></p>
        <p class="pc-sub" id="fig-note">The outline is drawn from the numbers only. Dashed: the first scan here.</p>
      </div>
    </div>
    <div class="bd-slide">
      <label class="pc-sub" for="slider">Slide between scans</label>
      <input type="range" id="slider" min="0" max="1" step="1" value="1">
      <div class="bd-ends"><span id="end-first"></span><span id="end-last"></span></div>
      <div class="bd-steps">
        <button type="button" id="step-back">Earlier scan</button>
        <button type="button" id="step-on">Later scan</button>
      </div>
    </div>
    <ul class="bd-rows" id="full-rows"></ul>
    <p class="pc-sub" id="full-ratio"></p>
    <div class="pc-actions"><button type="button" class="pc-btn pc-btn-secondary" id="done">Done</button></div>
  </section>
  <!--/full-->
  <p class="pc-sub" id="estimate"></p>
  <p class="pc-note" id="note" role="status"></p>
</main>
`;

const BODY_CARD_SCRIPT = `
(function(){
  "use strict";
  var card = window.PelarisCard;
  var $ = function(id){ return document.getElementById(id); };
  var data = null, full = false, pos = 0;
  var NAMES = { waistCm: "Waist", hipsCm: "Hips", shouldersCm: "Shoulders", weightKg: "Weight" };
  function el(tag, cls, txt){ var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function show(id, on){ $(id).classList.toggle("pc-hidden", !on); }
  function note(t){ $("note").textContent = t || ""; }
  function num(n){ return typeof n === "number" && isFinite(n) ? String(Math.round(n * 10) / 10) : ""; }
  function unit(k){ return k === "weightKg" ? (data.weightUnit || "kg") : (data.lengthUnit || "cm"); }
  function signed(n, u){
    if (typeof n !== "number" || !isFinite(n)) return "";
    var r = Math.round(n * 10) / 10;
    if (r === 0) return "0 " + u;
    return (r > 0 ? "+" : "\\u2212") + String(Math.abs(r)) + " " + u;
  }
  function stops(){ return data && Array.isArray(data.stops) ? data.stops : []; }

  // The outline: widths follow the circumferences, clamped to a sane range.
  function clamp(v, lo, hi, dflt){ return (typeof v === "number" && isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : dflt; }
  function half(cm){ return cm * 0.36 / 2; }
  function outline(s){
    var sh = half(clamp(s && s.shouldersCm, 85, 150, 112));
    var wa = half(clamp(s && s.waistCm, 55, 140, 82));
    var hi = half(clamp(s && s.hipsCm, 70, 150, 98));
    wa = Math.min(wa, Math.max(sh, hi));
    var c = 60, f = function(x){ return (Math.round(x * 10) / 10).toFixed(1); };
    return "M" + f(c - 4) + " 23 L" + f(c - 4) + " 28 L" + f(c - sh) + " 34 " +
      "L" + f(c - wa) + " 72 L" + f(c - hi) + " 92 L" + f(c - hi + 4) + " 146 L" + f(c - 3) + " 146 L" + f(c) + " 104 " +
      "L" + f(c + 3) + " 146 L" + f(c + hi - 4) + " 146 L" + f(c + hi) + " 92 L" + f(c + wa) + " 72 L" + f(c + sh) + " 34 " +
      "L" + f(c + 4) + " 28 L" + f(c + 4) + " 23";
  }

  function drawRows(list, items){
    list.replaceChildren();
    items.forEach(function(it){
      var li = el("li", "bd-row");
      li.append(el("span", "bd-name", it.name), el("span", "bd-val", it.value), el("span", "bd-ch", it.change));
      list.append(li);
    });
  }

  function drawInline(){
    drawRows($("rows"), (data.rows || []).map(function(r){
      return { name: r.label, value: num(r.value) + " " + unit(r.key), change: r.change == null ? "" : signed(r.change, unit(r.key)) };
    }));
    $("ratio").textContent = typeof data.shoulderToWaist === "number" ? "Shoulder to waist " + data.shoulderToWaist : "";
  }

  function drawFull(){
    var ss = stops(); if (!ss.length) return;
    pos = Math.max(0, Math.min(ss.length - 1, pos));
    var s = ss[pos], first = ss[0];
    var slider = $("slider");
    slider.max = String(ss.length - 1); slider.value = String(pos);
    slider.setAttribute("aria-valuetext", s.dateLabel + ", scan " + (pos + 1) + " of " + ss.length);
    $("end-first").textContent = first.dateLabel;
    $("end-last").textContent = ss[ss.length - 1].dateLabel;
    $("at").textContent = s.dateLabel + (data.derived && pos === 0 ? " (worked out from the changes)" : "");
    $("step-back").disabled = pos === 0;
    $("step-on").disabled = pos === ss.length - 1;
    $("fig-now").setAttribute("d", outline(s));
    $("fig-ghost").setAttribute("d", pos === 0 ? "" : outline(first));
    var items = [];
    ["waistCm", "hipsCm", "shouldersCm", "weightKg"].forEach(function(k){
      if (!ss.some(function(x){ return typeof x[k] === "number"; })) return;
      var v = s[k], change = "";
      if (typeof v !== "number") { items.push({ name: NAMES[k], value: "not measured", change: "" }); return; }
      if (pos > 0 && typeof first[k] === "number") change = signed(v - first[k], unit(k)) + " since " + first.dateLabel;
      items.push({ name: NAMES[k], value: num(v) + " " + unit(k), change: change });
    });
    drawRows($("full-rows"), items);
    $("full-ratio").textContent = pos === ss.length - 1 && typeof data.shoulderToWaist === "number" ? "Shoulder to waist " + data.shoulderToWaist : "";
  }

  function draw(){
    if (!data) return;
    $("date").textContent = data.dateLabel || "";
    $("since").textContent = data.previousLabel ? "Changes since your previous scan, " + data.previousLabel : "";
    $("estimate").textContent = data.estimateLine || "";
    var canCompare = stops().length > 1;
    show("compare", canCompare);
    var open = $("open");
    var hasLink = typeof data.openUrl === "string" && /^https:\\/\\//.test(data.openUrl);
    show("open", hasLink);
    if (hasLink) open.setAttribute("href", data.openUrl); else open.setAttribute("href", "#");
    drawInline();
    if (full) drawFull();
    show("inline-view", !full); show("full-view", full);
  }

  function setFull(on){ full = !!on && stops().length > 1; if (full) pos = stops().length - 1; draw(); }
  $("compare").addEventListener("click", function(){
    card.requestFullscreen().then(function(ok){
      setFull(true);
      if (!ok) note("Comparing here. Your chat app kept the card in place.");
      $("slider").focus();
    });
  });
  $("done").addEventListener("click", function(){ setFull(false); note(""); card.requestInline(); });
  $("slider").addEventListener("input", function(){ pos = Number($("slider").value) || 0; drawFull(); });
  $("step-back").addEventListener("click", function(){ pos -= 1; drawFull(); });
  $("step-on").addEventListener("click", function(){ pos += 1; drawFull(); });
  $("open").addEventListener("click", function(ev){
    ev.preventDefault();
    if (!data || typeof data.openUrl !== "string" || !/^https:\\/\\//.test(data.openUrl)) return;
    card.openLink(data.openUrl).then(function(ok){ if (!ok) note("Open Pelaris to see your scans."); });
  });
  card.onContext(function(ctx){
    if (ctx && ctx.displayMode === "fullscreen" && !full) setFull(true);
    else if (ctx && ctx.displayMode === "inline" && full) setFull(false);
  });
  card.onData(function(d){ data = d; full = false; draw(); });
})();
`;

export const BODY_CARD: CardDefinition = {
  id: "body",
  resourceUri: "ui://pelaris/cards/body-v1.html",
  title: "Pelaris body card",
  description: "Waist, hips and shoulders from the latest scan with the change since the one before, and a slider to compare scans.",
  fields: {
    dateLabel: true,
    previousLabel: true,
    lengthUnit: true,
    weightUnit: true,
    rows: { key: true, label: true, value: true, change: true },
    shoulderToWaist: true,
    stops: { dateLabel: true, waistCm: true, hipsCm: true, shouldersCm: true, weightKg: true },
    derived: true,
    estimateLine: true,
    openUrl: true,
  },
  html: () =>
    renderCardPage({
      title: "Pelaris body",
      css: BODY_CARD_CSS,
      body: BODY_CARD_BODY,
      script: BODY_CARD_SCRIPT,
      displayModes: ["inline", "fullscreen"],
    }),
};
