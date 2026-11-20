/**
 * Week card: the primary program's week as seven day tiles, under get_active_program.
 *
 * Inline: Monday to Sunday tiles (each with the session's own focus or slot text,
 * shortened by CSS, and minutes only when the server stored a length), the date range,
 * and two actions: "Rearrange this week" (asks the host for full screen) and
 * "Open in Pelaris" (the signed one-tap link to the program route). Where the host's
 * `availableDisplayModes` does not offer full screen, the first action is "Move a
 * session" instead, and the move view and day picker open in the card itself.
 *
 * Full screen: the days as a list. A planned session dated today or later and not yet
 * completed can move to another day of that week, by drag or by its "Move" button (a
 * day picker, for touch and keyboard). Nothing is written until the athlete confirms;
 * Confirm calls the app-only card_reschedule_session with `{ sessionId, newDate }`
 * through the host bridge. A move shows its result line in the card and sends nothing to
 * the chat by itself; "Tell the coach" (shown after a move, in the move view) sends a
 * one-line note when the athlete taps it. Confirm is disabled from the first tap until a definite
 * answer. Only when the host has no tool call for cards at all does the request go to
 * the chat as a message instead; a timeout or an error is never sent again (after a
 * timeout the card says to check Pelaris and offers no way to repeat that move).
 *
 * Which week: both weeks the tool returned (this week, and next week when the server
 * sent next-week sessions), with a plain switch between them. No skip, no rings.
 */

import type { HandoffRoute } from "../tools/shared/entry_links.js";
import type { CardDefinition } from "./card_shell.js";
import { renderCardPage } from "./templates.js";

/** Where "Open in Pelaris" lands. */
export const WEEK_CARD_OPEN_ROUTE: HandoffRoute = "program";

/** The write tool Confirm calls, and the input field it fills. */
/** The card's only write: the app-only move tool (see modify_training_session.ts). */
export const WEEK_CARD_MOVE_TOOL = "card_reschedule_session";

/** Shown when the move tool gave no answer in time: the move may have landed, so no retry. */
export const WEEK_CARD_PENDING_NOTE = "Still checking. Reopen your week in Pelaris to see where it landed.";

export interface WeekCardSession {
  sessionId: string;
  label: string;
  minutes: number | null;
  isCompleted: boolean;
  canMove: boolean;
}

export interface WeekCardDay {
  date: string;
  dayShort: string;
  dayName: string;
  dateLabel: string;
  /** The day is today or later, so a session may be moved onto it. */
  canReceive: boolean;
  sessions: WeekCardSession[];
}

export interface WeekCardWeek {
  key: "this" | "next";
  heading: string;
  weekLine: string | null;
  rangeLabel: string;
  days: WeekCardDay[];
}

export interface WeekCardData {
  programTitle: string | null;
  today: string | null;
  weeks: WeekCardWeek[];
  openUrl: string | null;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Raw = Record<string, unknown>;

function dayKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(m[3])) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function toDate(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function keyOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(key: string, n: number): string {
  const d = toDate(key);
  d.setUTCDate(d.getUTCDate() + n);
  return keyOf(d);
}

/** The Monday on or before a day (weeks run Monday to Sunday). */
export function mondayOf(key: string): string {
  const dow = toDate(key).getUTCDay();
  return addDays(key, dow === 0 ? -6 : 1 - dow);
}

/** "2026-11-23" to "Mon 23 Nov". */
export function weekDateLabel(key: string): string {
  const d = toDate(key);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function wholeMinutes(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function records(value: unknown): Raw[] {
  return Array.isArray(value)
    ? value.filter((v): v is Raw => v !== null && typeof v === "object" && !Array.isArray(v))
    : [];
}

function buildWeek(
  key: "this" | "next",
  monday: string,
  sessions: Raw[],
  today: string | null,
  weekLine: string | null,
): WeekCardWeek {
  const days: WeekCardDay[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(monday, i);
    const d = toDate(date);
    days.push({
      date,
      dayShort: WEEKDAYS[d.getUTCDay()],
      dayName: WEEKDAY_NAMES[d.getUTCDay()],
      dateLabel: weekDateLabel(date),
      canReceive: today != null && date >= today,
      sessions: [],
    });
  }
  for (const s of sessions) {
    const date = dayKey(s.scheduledDate);
    const sessionId = text(s.sessionId);
    if (!date || !sessionId) continue;
    const day = days.find((x) => x.date === date);
    if (!day) continue;
    const isCompleted = s.isCompleted === true;
    day.sessions.push({
      sessionId,
      // The session's own words: shortened by CSS in the card, never mapped by keyword.
      label: text(s.focus) ?? text(s.slotType) ?? "Session",
      minutes: wholeMinutes(s.durationMinutes),
      isCompleted,
      canMove: !isCompleted && today != null && date >= today,
    });
  }
  const sunday = addDays(monday, 6);
  return {
    key,
    heading: key === "this" ? "This week" : "Next week",
    weekLine,
    rangeLabel: `${weekDateLabel(monday)} to ${weekDateLabel(sunday)}`,
    days,
  };
}

/**
 * Maps the get_active_program reply to the card's data: the primary program (or the
 * first program that is not a manual log). Returns null when there is no program week
 * with a session in it, so the tool replies as text only.
 */
export function buildWeekCardData(result: Raw, openUrl: string | null): WeekCardData | null {
  const programs = records(result.programs).filter((p) => p.kind !== "manual_log");
  const primaryId = text(result.primaryProgramId);
  const program = programs.find((p) => primaryId != null && p.programId === primaryId) ?? programs[0];
  if (!program) return null;

  const today = dayKey(result.today);
  const start = dayKey(program.weekStartsOn) ?? (today != null ? mondayOf(today) : null);
  if (start == null) return null;
  const monday = mondayOf(start);

  const weeks: WeekCardWeek[] = [];
  const thisSessions = records(program.currentWeekSessions);
  const phase = records([program.currentPhase])[0];
  const phaseName = phase ? text(phase.phase) : null;
  const weekNumber = typeof program.currentWeek === "number" ? program.currentWeek : null;
  const thisLine = weekNumber != null ? `Week ${weekNumber}${phaseName ? `, ${phaseName}` : ""}` : null;
  weeks.push(buildWeek("this", monday, thisSessions, today, thisLine));

  if (Array.isArray(program.nextWeekSessions)) {
    const nextNumber = typeof program.nextWeekNumber === "number" ? program.nextWeekNumber : null;
    weeks.push(
      buildWeek("next", addDays(monday, 7), records(program.nextWeekSessions), today, nextNumber != null ? `Week ${nextNumber}` : null),
    );
  }

  const hasSession = weeks.some((w) => w.days.some((d) => d.sessions.length > 0));
  if (!hasSession) return null;

  return { programTitle: text(program.title), today, weeks, openUrl };
}

const WEEK_CARD_CSS = `
.wk-switch{display:flex;gap:6px;margin:10px 0 0}
.wk-switch button{flex:1 1 0;min-height:44px;border-radius:var(--pc-radius-sm);border:1px solid var(--pc-line-2);
  background:transparent;color:var(--pc-text);font:500 13.5px/1.2 var(--pc-font);cursor:pointer}
.wk-switch button[aria-pressed="true"]{border-color:var(--pc-accent);color:var(--pc-accent);font-weight:600}
.wk-tiles{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px;margin-top:10px;list-style:none;padding:0}
.wk-tile{background:var(--pc-bg-2);border-radius:8px;padding:6px 3px;text-align:center;min-height:64px;min-width:0}
.wk-tile b{display:block;font-size:11px;font-weight:600;color:var(--pc-text-2)}
.wk-tile span{display:block;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wk-tile .wk-min{color:var(--pc-text-2);font-size:11px}
.wk-tile.wk-rest span{color:var(--pc-text-2)}
.wk-tile.wk-moved{outline:2px solid var(--pc-accent);outline-offset:-2px}
.wk-days{list-style:none;margin:10px 0 0;padding:0}
.wk-day{border-top:1px solid var(--pc-line);padding:8px 0;min-height:52px}
.wk-day.wk-over{background:var(--pc-bg-2);outline:2px dashed var(--pc-accent);outline-offset:-2px}
.wk-day h3{font-size:12.5px;font-weight:600;margin:0 0 4px;color:var(--pc-text-2)}
.wk-sess{display:flex;align-items:center;gap:8px;padding:4px 0}
.wk-sess .wk-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wk-sess .wk-min{color:var(--pc-text-2);font-size:12.5px;white-space:nowrap}
.wk-sess[draggable="true"]{cursor:grab}
.wk-move{min-height:44px;min-width:64px;border-radius:var(--pc-radius-sm);border:1px solid var(--pc-line-2);
  background:transparent;color:var(--pc-text);font:500 13px/1.2 var(--pc-font);cursor:pointer}
.wk-move:focus-visible,.wk-pick button:focus-visible,.wk-switch button:focus-visible{outline:2px solid var(--pc-accent);outline-offset:2px}
.wk-empty{color:var(--pc-text-2);font-size:13px;margin:0}
.wk-panel{border:1px solid var(--pc-line-2);border-radius:var(--pc-radius-sm);padding:12px;margin-top:12px}
.wk-panel h2{font-size:15px;margin:0 0 4px}
.wk-panel p{margin:0;font-size:13.5px}
.wk-pick{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:6px;margin-top:8px}
.wk-pick button{min-height:44px;border-radius:var(--pc-radius-sm);border:1px solid var(--pc-line-2);background:transparent;
  color:var(--pc-text);font:500 13.5px/1.2 var(--pc-font);cursor:pointer}
`;

const WEEK_CARD_BODY = `
<main class="pc-card" aria-live="polite">
  <div class="pc-head">
    <h1 class="pc-title" id="heading">This week</h1>
    <span class="pc-meta" id="weekline"></span>
  </div>
  <p class="pc-sub" id="range"></p>
  <div class="wk-switch pc-hidden" id="switch" role="group" aria-label="Which week">
    <button type="button" id="sw-this" aria-pressed="true">This week</button>
    <button type="button" id="sw-next" aria-pressed="false">Next week</button>
  </div>
  <section id="inline-view">
    <ul class="wk-tiles" id="tiles" aria-label="Days of the week"></ul>
    <p class="pc-note" id="moved-line"></p>
    <div class="pc-actions">
      <button type="button" class="pc-btn pc-btn-primary" id="rearrange">Rearrange this week</button>
      <a class="pc-btn pc-btn-secondary" id="open" href="#" target="_blank" rel="noopener noreferrer">Open in Pelaris</a>
    </div>
  </section>
  <!--full-->
  <section id="full-view" class="pc-hidden">
    <p class="pc-sub">Drag a session to another day, or use Move. Nothing changes until you confirm.</p>
    <ul class="wk-days" id="days"></ul>
    <div class="wk-panel pc-hidden" id="picker" role="dialog" aria-labelledby="picker-title">
      <h2 id="picker-title">Move to which day?</h2>
      <div class="wk-pick" id="picker-days"></div>
      <div class="pc-actions"><button type="button" class="pc-btn pc-btn-secondary" id="picker-cancel">Cancel</button></div>
    </div>
    <div class="wk-panel pc-hidden" id="confirm" role="dialog" aria-labelledby="confirm-title">
      <h2 id="confirm-title"></h2>
      <p id="confirm-detail"></p>
      <div class="pc-actions">
        <button type="button" class="pc-btn pc-btn-primary" id="confirm-yes">Confirm</button>
        <button type="button" class="pc-btn pc-btn-secondary" id="confirm-no">Cancel</button>
      </div>
    </div>
    <div class="pc-actions">
      <button type="button" class="pc-btn pc-btn-secondary pc-hidden" id="tell">Tell the coach</button>
      <button type="button" class="pc-btn pc-btn-secondary" id="done">Done</button>
    </div>
  </section>
  <!--/full-->
  <p class="pc-note" id="note" role="status"></p>
</main>
`;

const WEEK_CARD_SCRIPT = `
(function(){
  "use strict";
  var card = window.PelarisCard;
  var $ = function(id){ return document.getElementById(id); };
  var tellText = null;
  var data = null, weekIdx = 0, full = false, inPlace = false, pending = null, movingId = null, busy = false, dragId = null;
  function el(tag, cls, txt){ var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function show(id, on){ $(id).classList.toggle("pc-hidden", !on); }
  function note(t){ $("note").textContent = t || ""; }
  function week(){ return data && Array.isArray(data.weeks) ? (data.weeks[weekIdx] || data.weeks[0]) : null; }
  function mins(s){ return typeof s.minutes === "number" ? s.minutes + " min" : ""; }
  function find(id){
    var w = week(); if (!w) return null;
    for (var i = 0; i < w.days.length; i++) {
      var ss = w.days[i].sessions || [];
      for (var j = 0; j < ss.length; j++) if (ss[j].sessionId === id) return { day: w.days[i], session: ss[j], index: j };
    }
    return null;
  }
  function dayByDate(date){ var w = week(); return w ? w.days.filter(function(d){ return d.date === date; })[0] : null; }

  function drawTiles(w){
    var list = $("tiles"); list.replaceChildren();
    w.days.forEach(function(d){
      var li = el("li", "wk-tile"); li.dataset.date = d.date;
      li.append(el("b", null, d.dayShort));
      var ss = d.sessions || [];
      if (ss.length === 0) { li.classList.add("wk-rest"); li.append(el("span", null, "Rest")); }
      ss.forEach(function(s){
        var name = el("span", null, s.label); name.title = s.label; li.append(name);
        if (typeof s.minutes === "number") li.append(el("span", "wk-min", String(s.minutes)));
        if (s.justMoved) li.classList.add("wk-moved");
      });
      li.setAttribute("aria-label", d.dateLabel + ": " + (ss.length ? ss.map(function(s){ return s.label + (mins(s) ? ", " + mins(s) : ""); }).join("; ") : "rest day"));
      list.append(li);
    });
  }

  function drawDays(w){
    var list = $("days"); list.replaceChildren();
    w.days.forEach(function(d){
      var li = el("li", "wk-day"); li.dataset.date = d.date;
      li.append(el("h3", null, d.dateLabel));
      var ss = d.sessions || [];
      if (ss.length === 0) li.append(el("p", "wk-empty", "Rest day"));
      ss.forEach(function(s){
        var row = el("div", "wk-sess");
        row.append(el("span", "wk-name", s.label + (s.isCompleted ? " (done)" : "")));
        if (mins(s)) row.append(el("span", "wk-min", mins(s)));
        if (s.canMove && !busy) {
          row.setAttribute("draggable", "true");
          row.addEventListener("dragstart", function(ev){ dragId = s.sessionId; try { ev.dataTransfer.setData("text/plain", s.sessionId); ev.dataTransfer.effectAllowed = "move"; } catch (e) {} });
          row.addEventListener("dragend", function(){ dragId = null; clearOver(); });
          var b = el("button", "wk-move", "Move"); b.type = "button";
          b.setAttribute("aria-label", "Move " + s.label + " from " + d.dateLabel);
          b.addEventListener("click", function(){ openPicker(s.sessionId); });
          row.append(b);
        }
        li.append(row);
      });
      if (d.canReceive) {
        li.addEventListener("dragover", function(ev){ if (dragId) { ev.preventDefault(); clearOver(); li.classList.add("wk-over"); } });
        li.addEventListener("dragleave", function(){ li.classList.remove("wk-over"); });
        li.addEventListener("drop", function(ev){ ev.preventDefault(); clearOver(); var id = dragId; dragId = null; if (id) ask(id, d.date); });
      }
      list.append(li);
    });
  }
  function clearOver(){ Array.prototype.forEach.call(document.querySelectorAll(".wk-over"), function(n){ n.classList.remove("wk-over"); }); }

  function draw(){
    var w = week(); if (!w) return;
    $("heading").textContent = w.heading || "This week";
    $("weekline").textContent = w.weekLine || "";
    $("range").textContent = w.rangeLabel || "";
    var two = data.weeks.length > 1;
    show("switch", two);
    $("sw-this").setAttribute("aria-pressed", String(weekIdx === 0));
    $("sw-next").setAttribute("aria-pressed", String(weekIdx === 1));
    // Where the host offers no full screen, the move happens in the card itself.
    $("rearrange").textContent = !card.canFullscreen() ? "Move a session" : weekIdx === 1 ? "Rearrange next week" : "Rearrange this week";
    drawTiles(w); drawDays(w);
    show("inline-view", !full); show("full-view", full);
    var open = $("open");
    if (typeof data.openUrl === "string" && /^https:\\/\\//.test(data.openUrl)) { open.setAttribute("href", data.openUrl); open.removeAttribute("aria-disabled"); }
    else { open.setAttribute("href", "#"); open.setAttribute("aria-disabled", "true"); }
  }
  function closePanels(){ pending = null; movingId = null; show("picker", false); show("confirm", false); }

  function openPicker(id){
    var f = find(id); if (!f) return;
    closePanels(); movingId = id;
    var box = $("picker-days"); box.replaceChildren();
    week().days.forEach(function(d){
      if (!d.canReceive || d.date === f.day.date) return;
      var b = el("button", null, d.dateLabel); b.type = "button";
      b.addEventListener("click", function(){ ask(id, d.date); });
      box.append(b);
    });
    $("picker-title").textContent = "Move " + f.session.label + " to which day?";
    if (!box.children.length) { note("There is no later day this week to move it to."); return; }
    show("picker", true); box.firstChild.focus();
  }

  function ask(id, toDate){
    var f = find(id), to = dayByDate(toDate);
    if (!f || !to || !f.session.canMove || !to.canReceive || f.day.date === toDate) return;
    closePanels();
    pending = { sessionId: id, label: f.session.label, minutes: f.session.minutes, from: f.day, to: to };
    $("confirm-title").textContent = "Move " + f.day.dayName + " " + f.session.label + " to " + to.dayName + "?";
    var detail = f.session.label + (mins(f.session) ? ", " + mins(f.session) : "") + ": " + f.day.dateLabel + " to " + to.dateLabel + ".";
    if ((to.sessions || []).length > 0) detail += " " + to.dayName + " will have " + ((to.sessions.length + 1) === 2 ? "two" : String(to.sessions.length + 1)) + " sessions.";
    detail += " The rest of your program stays as it is.";
    $("confirm-detail").textContent = detail;
    // A fresh question: Confirm is enabled again (a session still being checked has no Move).
    $("confirm-yes").disabled = false; $("confirm-yes").removeAttribute("aria-disabled");
    show("confirm", true); $("confirm-yes").focus();
  }

  function resultBody(res){
    if (!res || typeof res !== "object") return null;
    if (res.structuredContent && typeof res.structuredContent === "object") return res.structuredContent;
    var c = Array.isArray(res.content) ? res.content.filter(function(b){ return b && b.type === "text"; })[0] : null;
    if (!c) return null;
    try { var o = JSON.parse(c.text); return o && typeof o === "object" ? o : null; } catch (e) { return { message: String(c.text || "") }; }
  }
  function errorText(res){
    var c = res && Array.isArray(res.content) ? res.content.filter(function(b){ return b && b.type === "text"; })[0] : null;
    return c && typeof c.text === "string" ? c.text.replace(/^Error:\\s*/, "") : "";
  }
  function applyMove(p, newDate){
    var f = find(p.sessionId); var to = dayByDate(newDate);
    if (!f) return;
    f.day.sessions.splice(f.index, 1);
    week().days.forEach(function(d){ (d.sessions || []).forEach(function(s){ s.justMoved = false; }); });
    f.session.justMoved = true;
    if (to) to.sessions.push(f.session);
  }

  function confirmMove(){
    var p = pending; if (!p || busy) return;
    // Disabled from the first tap until a definite answer, so a double tap sends once.
    busy = true; $("confirm-yes").disabled = true; $("confirm-yes").setAttribute("aria-disabled", "true");
    show("confirm", false); note("Moving " + p.label + "...");
    var chatAsk = "Please move my " + p.label + " from " + p.from.dateLabel + " to " + p.to.dateLabel + " (session " + p.sessionId + ").";
    card.callTool(${JSON.stringify(WEEK_CARD_MOVE_TOOL)}, { sessionId: p.sessionId, newDate: p.to.date }).then(function(res){
      if (res === false) {
        return card.sendMessage(chatAsk).then(function(ok){
          note(ok ? "Sent to the chat, so the assistant can make the change." : "Ask in the chat to move this session.");
        });
      }
      if (res === "pending") {
        // No answer in time: the move may have landed. Never send it again from here.
        var f = find(p.sessionId); if (f) f.session.canMove = false;
        note(${JSON.stringify(WEEK_CARD_PENDING_NOTE)});
        return;
      }
      var body = resultBody(res);
      if (res && res.isError) { note(errorText(res) || "That session could not move."); return; }
      var moved = body && Array.isArray(body.moved) ? body.moved.filter(function(m){ return m && m.sessionId === p.sessionId; })[0] : null;
      if (moved) {
        var newDate = moved && typeof moved.newDate === "string" ? moved.newDate : p.to.date;
        applyMove(p, newDate);
        var to = dayByDate(newDate) || p.to;
        var line = "Moved: " + p.label + ", " + p.from.dateLabel + " to " + to.dateLabel;
        $("moved-line").textContent = line; note(line);
        // Nothing goes to the chat by itself: the athlete can tell the coach with a tap.
        tellText = "I moved my " + p.label + " from " + p.from.dateLabel + " to " + to.dateLabel + " in the week card.";
        show("tell", true);
        draw();
        return;
      }
      if (res === true) { note("Sent. Check the week in Pelaris to see the change."); return; }
      var other = body ? [].concat(body.needsAthlete || [], body.failed || [], body.skipped || []).filter(function(m){ return m && m.sessionId === p.sessionId; })[0] : null;
      note((other && other.reason ? other.reason + ". " : "") + (body && body.message ? body.message : "That session could not move."));
    }).then(function(){ busy = false; pending = null; draw(); }, function(){ busy = false; pending = null; note("That session could not move."); draw(); });
  }

  function setFull(on){ full = !!on; if (!full) { closePanels(); inPlace = false; } draw(); }
  $("rearrange").addEventListener("click", function(){
    if (!card.canFullscreen()) { inPlace = true; setFull(true); return; }
    card.requestFullscreen().then(function(ok){
      inPlace = !ok;
      setFull(true);
      if (!ok) note("Rearranging here. Your chat app kept the card in place.");
    });
  });
  $("done").addEventListener("click", function(){ var wasInPlace = inPlace; setFull(false); if (!wasInPlace) card.requestInline(); });
  $("sw-this").addEventListener("click", function(){ weekIdx = 0; closePanels(); draw(); });
  $("sw-next").addEventListener("click", function(){ weekIdx = 1; closePanels(); draw(); });
  $("picker-cancel").addEventListener("click", function(){ closePanels(); note(""); });
  $("confirm-no").addEventListener("click", function(){ closePanels(); note("Nothing changed."); });
  $("confirm-yes").addEventListener("click", confirmMove);
  $("tell").addEventListener("click", function(){
    var t = tellText; if (!t) return;
    tellText = null; show("tell", false);
    card.sendMessage(t).then(function(ok){ if (!ok) note("Tell the coach in the chat."); });
  });
  $("open").addEventListener("click", function(ev){
    ev.preventDefault();
    if (!data || typeof data.openUrl !== "string" || !/^https:\\/\\//.test(data.openUrl)) { note("Open Pelaris to see your week."); return; }
    card.openLink(data.openUrl).then(function(ok){ if (!ok) note("Open Pelaris to see your week."); });
  });
  card.onContext(function(ctx){
    if (ctx && ctx.displayMode === "fullscreen" && !full) { inPlace = false; setFull(true); }
    else if (ctx && ctx.displayMode === "inline" && full && !inPlace) setFull(false);
    else if (data) draw();
  });
  card.onData(function(d){ data = d; weekIdx = 0; tellText = null; show("tell", false); draw(); });
})();
`;

export const WEEK_CARD: CardDefinition = {
  id: "week",
  resourceUri: "ui://pelaris/cards/week-v1.html",
  title: "Pelaris week card",
  description: "The program week, Monday to Sunday, with Rearrange (move a session after you confirm) and Open in Pelaris.",
  fields: {
    programTitle: true,
    today: true,
    weeks: {
      key: true,
      heading: true,
      weekLine: true,
      rangeLabel: true,
      days: {
        date: true,
        dayShort: true,
        dayName: true,
        dateLabel: true,
        canReceive: true,
        sessions: { sessionId: true, label: true, minutes: true, isCompleted: true, canMove: true },
      },
    },
    openUrl: true,
  },
  html: () =>
    renderCardPage({
      title: "Pelaris week",
      css: WEEK_CARD_CSS,
      body: WEEK_CARD_BODY,
      script: WEEK_CARD_SCRIPT,
      displayModes: ["inline", "fullscreen"],
    }),
};
