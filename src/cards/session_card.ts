/**
 * Session card: one planned session at a glance, under get_session_details.
 *
 * Shows the title, the date, the length, a warm-up line (only when a block's
 * semanticType is "warm_up", the value Pelaris writes for warm-up blocks), and one row
 * per main-set exercise. Two actions, the most an inline card may carry:
 * - "Start in Pelaris": the signed one-tap entry link (route below);
 * - "Swap an exercise": asks the host to send a chat message, so the assistant runs
 *   the swap_exercise flow, which asks before it changes anything.
 * No photos, no rings, no streaks.
 */

import type { HandoffRoute } from "../tools/shared/entry_links.js";
import { defineCard } from "./card_shell.js";

/**
 * Where "Start in Pelaris" lands. Today the Train tab; change this one constant when a
 * per-session route is added to HANDOFF_ROUTES.
 */
export const SESSION_CARD_START_ROUTE: HandoffRoute = "train";

/** Block semanticType values. Only WARM_UP is read as a warm-up. */
export const WARM_UP_SEMANTIC_TYPE = "warm_up";
const NOT_MAIN_SET = new Set([WARM_UP_SEMANTIC_TYPE, "cool_down"]);

export interface SessionCardRow {
  name: string;
  detail: string;
}

export interface SessionCardData {
  title: string;
  dateLabel: string | null;
  durationLabel: string | null;
  warmUp: string | null;
  rows: SessionCardRow[];
  startUrl: string | null;
  swapPrompt: string;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-20" to "Fri 20 Nov". Anything else (no reliable calendar day) gives null. */
export function formatSessionDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(m[3])) return null;
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function trimNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

/** All the same number, or null when they differ or any is missing. */
function same(values: Array<number | null>): number | null {
  if (values.length === 0 || values.some((v) => v == null)) return null;
  return values.every((v) => v === values[0]) ? values[0] : null;
}

export function formatDistance(meters: number): string {
  return meters >= 1000 ? `${trimNumber(meters / 1000)} km` : `${trimNumber(meters)} m`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 90) return `${trimNumber(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${trimNumber(Math.round(minutes * 2) / 2)} min`;
  const h = Math.floor(minutes / 60);
  const rest = Math.round(minutes - h * 60);
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

function prefix(count: number, label: string): string {
  return count > 1 ? `${count} x ${label}` : label;
}

/** One exercise's sets as a short line, e.g. "3 x 8 · 20 kg" or "6 x 800 m". */
export function describeSets(sets: Array<Record<string, unknown>>): string {
  if (sets.length === 0) return "";
  const count = sets.length;
  const type = sets[0].type;

  if (type === "cardio") {
    const distance = same(sets.map((s) => num(s.targetDistanceMeters)));
    if (distance != null) return prefix(count, formatDistance(distance));
    const duration = same(sets.map((s) => num(s.targetDurationSec)));
    if (duration != null) return prefix(count, formatDuration(duration));
    return count > 1 ? `${count} sets` : "";
  }

  if (type === "strength") {
    const parts: string[] = [];
    const reps = same(sets.map((s) => num(s.targetReps)));
    const hold = same(sets.map((s) => num(s.targetDurationSec)));
    if (reps != null) parts.push(`${count} x ${trimNumber(reps)}`);
    else if (hold != null) parts.push(prefix(count, `${trimNumber(hold)}s hold`));
    else parts.push(count > 1 ? `${count} sets` : "1 set");
    const weight = same(sets.map((s) => num(s.targetWeightKg)));
    const rpe = same(sets.map((s) => num(s.targetRpe)));
    if (weight != null) parts.push(`${trimNumber(weight)} kg`);
    else if (rpe != null) parts.push(`RPE ${trimNumber(rpe)}`);
    return parts.join(" · ");
  }

  const duration = same(sets.map((s) => num(s.targetDurationSec)));
  if (duration != null) return prefix(count, formatDuration(duration));
  return count > 1 ? `${count} sets` : "";
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v))
    : [];
}

function exerciseName(ex: Record<string, unknown>): string | null {
  return typeof ex.exerciseName === "string" && ex.exerciseName.trim() ? ex.exerciseName.trim() : null;
}

/**
 * Maps the get_session_details reply to the card's data. Returns null when there is
 * nothing worth a card (no exercises), so the tool replies as text only.
 */
export function buildSessionCardData(
  session: Record<string, unknown>,
  startUrl: string | null,
): SessionCardData | null {
  const blocks = asRecords(session.blocks);
  const warmUpNames: string[] = [];
  const rows: SessionCardRow[] = [];

  for (const block of blocks) {
    const semantic = typeof block.semanticType === "string" ? block.semanticType : null;
    const exercises = asRecords(block.exercises);
    if (semantic === WARM_UP_SEMANTIC_TYPE) {
      for (const ex of exercises) {
        const name = exerciseName(ex);
        if (name) warmUpNames.push(name);
      }
      continue;
    }
    if (semantic != null && NOT_MAIN_SET.has(semantic)) continue;
    for (const ex of exercises) {
      const name = exerciseName(ex);
      if (!name) continue;
      rows.push({ name, detail: describeSets(asRecords(ex.sets)) });
    }
  }

  if (rows.length === 0 && warmUpNames.length === 0) return null;

  const title =
    typeof session.title === "string" && session.title.trim() ? session.title.trim() : "Your session";
  const minutes = num(session.durationMinutes);

  return {
    title,
    dateLabel: formatSessionDate(session.scheduledDate),
    durationLabel: minutes != null ? `${trimNumber(minutes)} min` : null,
    warmUp: warmUpNames.length > 0 ? warmUpNames.join(", ") : null,
    rows,
    startUrl,
    swapPrompt: `I'd like to swap an exercise in my ${title} session.`,
  };
}

const SESSION_CARD_BODY = `
<main class="pc-card" aria-live="polite">
  <div class="pc-head">
    <h1 class="pc-title" id="title">Your session</h1>
    <span class="pc-meta" id="duration"></span>
  </div>
  <p class="pc-sub" id="date"></p>
  <section id="warmup-section" class="pc-hidden">
    <h2 class="pc-sec">Warm-up</h2>
    <p class="pc-line" id="warmup"></p>
  </section>
  <section id="main-section" class="pc-hidden">
    <h2 class="pc-sec">Main set</h2>
    <ul class="pc-rows" id="rows"></ul>
  </section>
  <div class="pc-actions">
    <a class="pc-btn pc-btn-primary" id="start" href="#" target="_blank" rel="noopener noreferrer">Start in Pelaris</a>
    <button type="button" class="pc-btn pc-btn-secondary" id="swap">Swap an exercise</button>
  </div>
  <p class="pc-note" id="note" role="status"></p>
</main>
`;

const SESSION_CARD_SCRIPT = `
(function(){
  "use strict";
  var card = window.PelarisCard;
  var $ = function(id){ return document.getElementById(id); };
  var current = null;
  function text(id, value){ $(id).textContent = value || ""; }
  function show(id, on){ $(id).classList.toggle("pc-hidden", !on); }
  function draw(d){
    current = d;
    text("title", d.title || "Your session");
    text("duration", d.durationLabel);
    text("date", d.dateLabel);
    show("date", !!d.dateLabel);
    text("warmup", d.warmUp);
    show("warmup-section", !!d.warmUp);
    var list = $("rows");
    list.replaceChildren();
    (Array.isArray(d.rows) ? d.rows : []).forEach(function(r){
      var li = document.createElement("li"); li.className = "pc-row";
      var a = document.createElement("span"); a.textContent = r.name || "";
      var b = document.createElement("span"); b.textContent = r.detail || "";
      li.append(a, b); list.append(li);
    });
    show("main-section", list.children.length > 0);
    var start = $("start");
    if (typeof d.startUrl === "string" && /^https:\\/\\//.test(d.startUrl)) {
      start.setAttribute("href", d.startUrl); start.removeAttribute("aria-disabled");
    } else {
      start.setAttribute("href", "#"); start.setAttribute("aria-disabled", "true");
    }
  }
  $("start").addEventListener("click", function(ev){
    ev.preventDefault();
    if (!current || typeof current.startUrl !== "string" || !/^https:\\/\\//.test(current.startUrl)) {
      text("note", "Open Pelaris to start this session."); return;
    }
    card.openLink(current.startUrl).then(function(ok){
      if (!ok) text("note", "Open Pelaris to start this session.");
    });
  });
  $("swap").addEventListener("click", function(){
    var prompt = (current && current.swapPrompt) || "I'd like to swap an exercise in this session.";
    card.sendMessage(prompt).then(function(ok){
      text("note", ok ? "" : "Ask in the chat to swap an exercise.");
    });
  });
  card.onData(draw);
})();
`;

export const SESSION_CARD = defineCard<SessionCardData>({
  id: "session",
  v: 1,
  title: "Pelaris session card",
  description: "One planned session: its exercises, with Start in Pelaris and Swap an exercise.",
  fields: {
    title: true,
    dateLabel: true,
    durationLabel: true,
    warmUp: true,
    rows: { name: true, detail: true },
    startUrl: true,
    swapPrompt: true,
  },
  page: {
    title: "Pelaris session",
    body: SESSION_CARD_BODY,
    script: SESSION_CARD_SCRIPT,
  },
});
