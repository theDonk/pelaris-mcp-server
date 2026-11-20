/**
 * Card templates: the shared page, styles and host bridge every card uses.
 *
 * Dependency-free on purpose: no CDN, no fonts, no outside requests. The page carries
 * its own Content-Security-Policy meta as well as the host's sandbox CSP. Scripts are
 * inline blocks only (the MCP Apps default CSP allows inline scripts); the page has no
 * inline event handler attributes, every handler is attached from script.
 *
 * Card data is drawn with textContent only, never innerHTML, so nothing in a tool
 * result can become markup.
 */

/** Page-level CSP, the same or stricter than the MCP Apps default. */
export const CARD_PAGE_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data:; media-src 'none'; connect-src 'none'; font-src 'none'; " +
  "frame-src 'none'; base-uri 'none'; form-action 'none'";

/**
 * Shared styles. Surround colours, fonts and radii come from the host's standard
 * MCP Apps style variables, with neutral fallbacks for light and dark. The Pelaris
 * accent is used on buttons only. Tap targets are at least 44 px, and the layout
 * holds from 320 px wide.
 */
export const CARD_BASE_CSS = `
:root{
  color-scheme: light dark;
  --pc-bg: var(--color-background-primary, #ffffff);
  --pc-bg-2: var(--color-background-secondary, #f4f6f8);
  --pc-text: var(--color-text-primary, #111827);
  --pc-text-2: var(--color-text-secondary, #4b5563);
  --pc-line: var(--color-border-tertiary, var(--color-border-secondary, #e5e7eb));
  --pc-line-2: var(--color-border-primary, #9ca3af);
  --pc-radius: var(--border-radius-lg, 12px);
  --pc-radius-sm: var(--border-radius-md, 10px);
  --pc-font: var(--font-sans, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  --pc-accent: #1677d2;
  --pc-on-accent: #ffffff;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --pc-bg: var(--color-background-primary, #1f1f1f);
    --pc-bg-2: var(--color-background-secondary, #2a2a2a);
    --pc-text: var(--color-text-primary, #ececec);
    --pc-text-2: var(--color-text-secondary, #a3a3a3);
    --pc-line: var(--color-border-tertiary, var(--color-border-secondary, #3a3a3a));
    --pc-line-2: var(--color-border-primary, #5a5a5a);
    --pc-accent: #2fa4ff;
    --pc-on-accent: #04121f;
  }
}
:root[data-theme="dark"]{
  --pc-bg: var(--color-background-primary, #1f1f1f);
  --pc-bg-2: var(--color-background-secondary, #2a2a2a);
  --pc-text: var(--color-text-primary, #ececec);
  --pc-text-2: var(--color-text-secondary, #a3a3a3);
  --pc-line: var(--color-border-tertiary, var(--color-border-secondary, #3a3a3a));
  --pc-line-2: var(--color-border-primary, #5a5a5a);
  --pc-accent: #2fa4ff;
  --pc-on-accent: #04121f;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:transparent}
body{font:14px/1.45 var(--pc-font);color:var(--pc-text);min-width:280px}
.pc-card{background:var(--pc-bg);color:var(--pc-text);padding:14px 16px;border-radius:var(--pc-radius)}
.pc-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.pc-title{font-size:17px;font-weight:600;margin:0;flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.pc-meta{font-size:12.5px;color:var(--pc-text-2);white-space:nowrap}
.pc-sub{font-size:12.5px;color:var(--pc-text-2);margin:2px 0 0}
.pc-sec{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--pc-text-2);margin:12px 0 2px}
.pc-line{font-size:13.5px;margin:0;overflow-wrap:anywhere}
.pc-rows{list-style:none;margin:0;padding:0}
.pc-row{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid var(--pc-line);font-size:13.5px}
.pc-row span:first-child{min-width:0;overflow-wrap:anywhere}
.pc-row span:last-child{color:var(--pc-text-2);text-align:right;flex:0 0 auto;max-width:55%}
.pc-actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
.pc-btn{flex:1 1 130px;min-height:44px;display:inline-flex;align-items:center;justify-content:center;
  padding:10px 14px;border-radius:var(--pc-radius-sm);font:600 14px/1.2 var(--pc-font);text-decoration:none;
  cursor:pointer;border:1px solid transparent;text-align:center}
.pc-btn-primary{background:var(--pc-accent);color:var(--pc-on-accent)}
.pc-btn-secondary{background:transparent;color:var(--pc-text);border-color:var(--pc-line-2);font-weight:500}
.pc-btn:focus-visible{outline:2px solid var(--pc-accent);outline-offset:2px}
.pc-btn[aria-disabled="true"]{opacity:.55;cursor:default}
.pc-note{font-size:12px;color:var(--pc-text-2);margin:8px 0 0;min-height:1em}
.pc-hidden{display:none}
`;

/** What a card shows when it gets a payload it does not know (another card, another version). */
export const CARD_FALLBACK_LINE = "Open in Pelaris to see this.";

/**
 * The host bridge, exposed to card scripts as `window.PelarisCard`.
 *
 * Speaks the MCP Apps JSON-RPC protocol over postMessage to the parent frame:
 * `ui/initialize` then `ui/notifications/initialized`; listens for
 * `ui/notifications/tool-result` and `ui/notifications/host-context-changed`;
 * reports `ui/notifications/size-changed`. Actions, each with a graceful fallback:
 * - sendMessage(text): `ui/message`, else `window.openai.sendFollowUpMessage`
 * - openLink(url): `ui/open-link`, else `window.openai.openExternal`, else a new tab
 * - callTool(name, args): `tools/call`, else `window.openai.callTool`; resolves to the
 *   tool's result object (or true when a path gave none back), false when no path exists,
 *   "pending" when the host did not answer in time; a host error is an isError result
 * - requestFullscreen() / requestInline(): `ui/request-display-mode`, else
 *   `window.openai.requestDisplayMode`; resolve to whether the host set that mode
 * - canFullscreen(): whether the host offers full screen (`hostContext.availableDisplayModes`)
 * - sendMessage and openLink resolve to false on an `isError` result
 * A fallback runs only when there is no host connection or the host answers
 * method-not-found (-32601), never after a timeout or an error, so nothing is sent twice.
 * - onContext(fn): called with the host context on connect and on every change
 *   (for example `displayMode` moving between inline and fullscreen)
 * Each other action resolves to true when some path accepted it and false when none
 * did, so a card can show a plain note instead of a dead button.
 */
export const CARD_BRIDGE_JS = `
(function(){
  "use strict";
  var PROTOCOL_VERSION = "2026-01-26";
  var DATA_KEY = "pelaris/card";
  var DISPLAY_MODES = Array.isArray(window.PELARIS_CARD_DISPLAY_MODES) ? window.PELARIS_CARD_DISPLAY_MODES : ["inline"];
  // The one payload this page draws: { card, v, data } with its own card id and version.
  var ACCEPTS = window.PELARIS_CARD_ACCEPTS || {};
  var CALL_TIMEOUT_MS = 30000;
  var nextId = 1;
  var pending = {};
  var listeners = [];
  var contextListeners = [];
  var lastData = null;
  var host = { connected: false, capabilities: {}, context: {} };
  var parentWin = window.parent && window.parent !== window ? window.parent : null;
  var oa = function(){ return (typeof window.openai === "object" && window.openai) ? window.openai : null; };

  // An error that says why a request failed: { noHost }, { timeout } or a JSON-RPC { code }.
  function failure(message, extra){ var e = new Error(message); Object.keys(extra || {}).forEach(function(k){ e[k] = extra[k]; }); return e; }
  // Another transport is tried only when the standard path is not there at all: no host
  // connection, or the host answers method-not-found. Never after a timeout or an error
  // result, because the first request may already have run (a write must not run twice).
  function mayFallBack(err){ return !host.connected || !!(err && (err.noHost || err.code === -32601)); }
  function post(msg){ if (parentWin) parentWin.postMessage(msg, "*"); }
  function request(method, params, timeoutMs){
    return new Promise(function(resolve, reject){
      if (!parentWin) { reject(failure("no host", { noHost: true })); return; }
      var id = nextId++;
      var timer = setTimeout(function(){ delete pending[id]; reject(failure("timeout", { timeout: true })); }, timeoutMs || 8000);
      pending[id] = { resolve: function(v){ clearTimeout(timer); resolve(v); },
                      reject: function(e){ clearTimeout(timer); reject(e); } };
      post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    });
  }
  function notify(method, params){ post({ jsonrpc: "2.0", method: method, params: params || {} }); }

  function applyContext(ctx){
    if (!ctx || typeof ctx !== "object") return;
    host.context = Object.assign({}, host.context, ctx);
    contextListeners.forEach(function(fn){ try { fn(host.context); } catch (e) { /* never breaks the bridge */ } });
    var root = document.documentElement;
    if (ctx.theme === "light" || ctx.theme === "dark") root.setAttribute("data-theme", ctx.theme);
    var vars = ctx.styles && ctx.styles.variables;
    if (vars && typeof vars === "object") {
      Object.keys(vars).forEach(function(k){
        if (/^--[a-z0-9-]+$/.test(k) && typeof vars[k] === "string") root.style.setProperty(k, vars[k]);
      });
    }
  }
  // A payload for another card, or a data version this page does not know, is never
  // drawn: the card shows the plain fallback line instead of guessing at the data.
  function fallbackLine(){
    var main = document.querySelector("main") || document.body;
    var p = document.createElement("p"); p.className = "pc-line";
    p.textContent = ${JSON.stringify(CARD_FALLBACK_LINE)};
    main.replaceChildren(p);
  }
  function deliver(payload){
    if (!payload || typeof payload !== "object") return;
    var data = payload.data;
    if (payload.card !== ACCEPTS.card || payload.v !== ACCEPTS.v || !data || typeof data !== "object") {
      lastData = null; fallbackLine(); return;
    }
    lastData = data;
    listeners.forEach(function(fn){ try { fn(data); } catch (e) { /* a card error never breaks the bridge */ } });
  }
  function dataFromResult(result){
    var meta = result && result._meta;
    return meta && typeof meta === "object" ? meta[DATA_KEY] : null;
  }

  window.addEventListener("message", function(ev){
    if (!parentWin || ev.source !== parentWin) return;
    var m = ev.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id != null && pending[m.id] && !m.method) {
      var p = pending[m.id]; delete pending[m.id];
      if (m.error) p.reject(failure(m.error.message || "error", { code: m.error.code })); else p.resolve(m.result);
      return;
    }
    if (m.method === "ui/notifications/tool-result") deliver(dataFromResult(m.params));
    else if (m.method === "ui/notifications/host-context-changed") applyContext(m.params);
    else if (m.method === "ui/resource-teardown" && m.id != null) post({ jsonrpc: "2.0", id: m.id, result: {} });
  });

  function reportSize(){
    var el = document.documentElement;
    notify("ui/notifications/size-changed", { width: Math.ceil(el.scrollWidth), height: Math.ceil(el.scrollHeight) });
  }

  // ── Host section: ChatGPT's own runtime (window.openai) ─────────────────────
  // The only host-specific code in the bridge. The standard MCP Apps path above is
  // always tried first; these run only where that path is not there.
  var openaiHost = {
    watch: function(){
      var read = function(){
        var g = oa();
        if (g && g.toolResponseMetadata) deliver(g.toolResponseMetadata[DATA_KEY]);
        if (g && g.theme) applyContext({ theme: g.theme });
      };
      read();
      window.addEventListener("openai:set_globals", read);
    },
    sendMessage: function(text){ var o = oa(); if (o && o.sendFollowUpMessage) return o.sendFollowUpMessage({ prompt: text }); return false; },
    openLink: function(url){ var o = oa(); if (o && o.openExternal) return o.openExternal({ href: url }); return false; },
    callTool: function(name, args){ var o = oa(); if (o && o.callTool) return o.callTool(name, args || {}); return false; },
    displayMode: function(mode){ var o = oa(); if (o && o.requestDisplayMode) return o.requestDisplayMode({ mode: mode }); return false; }
  };
  // ── End of host section ─────────────────────────────────────────────────────

  function connect(){
    openaiHost.watch();
    if (!parentWin) return;
    request("ui/initialize", {
      protocolVersion: PROTOCOL_VERSION,
      appInfo: { name: "pelaris-card", version: "1" },
      appCapabilities: { availableDisplayModes: DISPLAY_MODES }
    }).then(function(res){
      host.connected = true;
      host.capabilities = (res && res.hostCapabilities) || {};
      applyContext(res && res.hostContext);
      notify("ui/notifications/initialized", {});
      reportSize();
    }).catch(function(){ /* no MCP Apps host: fallbacks below still work */ });
    if (typeof ResizeObserver === "function") new ResizeObserver(reportSize).observe(document.body);
  }

  function fallBack(fallback, keep){
    try { var r = fallback(); return Promise.resolve(r).then(function(v){ return v === false ? false : keep(v); }); }
    catch (e) { return Promise.resolve(false); }
  }
  function primaryOr(primary, fallback, keep, onFail){
    return (host.connected ? primary() : Promise.reject(failure("not connected", { noHost: true })))
      .then(keep, function(err){ return mayFallBack(err) ? fallBack(fallback, keep) : onFail(err); })
      .catch(function(){ return false; });
  }
  // Resolves to true when a path accepted the action, false when none did (an isError
  // result counts as not accepted, so the card can say so).
  function attempt(primary, fallback){
    return primaryOr(primary, fallback,
      function(v){ return !(v && typeof v === "object" && v.isError === true); },
      function(){ return false; });
  }
  // Resolves to whether the host actually set the mode it was asked for (the result's
  // \`mode\` is the mode the host chose, which may not be the one requested).
  function displayMode(mode){
    return primaryOr(
      function(){ return request("ui/request-display-mode", { mode: mode }); },
      function(){ return openaiHost.displayMode(mode); },
      function(v){ return (v && typeof v === "object" && typeof v.mode === "string") ? v.mode === mode : v !== false; },
      function(){ return false; });
  }
  // The modes the host offers: hostContext.availableDisplayModes (from ui/initialize and
  // host-context-changed). With no MCP Apps host, the ChatGPT runtime's own display mode
  // call counts as an offer of full screen.
  function displayModesOffered(){
    var list = host.context && host.context.availableDisplayModes;
    if (Array.isArray(list)) return list;
    var o = oa();
    return (!host.connected && o && typeof o.requestDisplayMode === "function") ? ["inline", "fullscreen"] : ["inline"];
  }

  // ── Page helpers every card shares ──────────────────────────────────────────
  function byId(id){ return document.getElementById(id); }
  function isHttps(url){ return typeof url === "string" && /^https:\\/\\//.test(url); }
  var api;

  api = window.PelarisCard = {
    // DOM: by id; a new element with a class and text; show or hide; the card's #note line.
    $: byId,
    el: function(tag, cls, txt){ var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; },
    text: function(id, value){ byId(id).textContent = value || ""; },
    show: function(id, on){ byId(id).classList.toggle("pc-hidden", !on); },
    note: function(t){ byId("note").textContent = t || ""; },
    isHttps: isHttps,
    // "Open in Pelaris": an https link only. Sets the link's href (a missing link is
    // aria-disabled, or hidden with { hide: true }).
    setLink: function(id, url, opts){
      var a = byId(id), ok = isHttps(url);
      if (opts && opts.hide) { api.show(id, ok); a.setAttribute("href", ok ? url : "#"); return; }
      if (ok) { a.setAttribute("href", url); a.removeAttribute("aria-disabled"); }
      else { a.setAttribute("href", "#"); a.setAttribute("aria-disabled", "true"); }
    },
    // The click: opens the link through the host; shows \`failNote\` when it cannot (and when
    // there is no link, unless { quiet: true }).
    wireLink: function(id, getUrl, failNote, opts){
      byId(id).addEventListener("click", function(ev){
        ev.preventDefault();
        var url = getUrl();
        if (!isHttps(url)) { if (!(opts && opts.quiet)) api.note(failNote); return; }
        api.openLink(url).then(function(ok){ if (!ok) api.note(failNote); });
      });
    },
    // The full-screen toggle: \`open\` asks the host for full screen, \`done\` goes back inline,
    // and the host's own display mode changes are followed. o.set(on) draws the card's view;
    // o.isFull() says which view is up. With o.inPlace, the full view opens in the card
    // itself where the host offers no full screen or keeps the card inline, and Done then
    // asks nothing of the host. o.opened(ok) runs after the host answers; o.closed() after Done;
    // o.refresh() on any other context change.
    fullScreen: function(o){
      var inPlace = false;
      function enter(place){ inPlace = !!place; o.set(true); }
      function leave(){ inPlace = false; o.set(false); }
      byId(o.open).addEventListener("click", function(){
        if (o.inPlace && !api.canFullscreen()) { enter(true); return; }
        api.requestFullscreen().then(function(ok){
          enter(o.inPlace && !ok);
          if (o.opened) o.opened(ok);
        });
      });
      byId(o.done).addEventListener("click", function(){
        var wasInPlace = inPlace; leave();
        if (o.closed) o.closed();
        if (!wasInPlace) api.requestInline();
      });
      api.onContext(function(ctx){
        if (ctx && ctx.displayMode === "fullscreen" && !o.isFull()) enter(false);
        else if (ctx && ctx.displayMode === "inline" && o.isFull() && !inPlace) leave();
        else if (o.refresh) o.refresh();
      });
    },
    onData: function(fn){ listeners.push(fn); if (lastData) fn(lastData); },
    onContext: function(fn){ contextListeners.push(fn); fn(host.context); },
    hostContext: function(){ return host.context; },
    sendMessage: function(text){
      return attempt(
        function(){ return request("ui/message", { role: "user", content: [{ type: "text", text: text }] }); },
        function(){ return openaiHost.sendMessage(text); });
    },
    openLink: function(url){
      return attempt(
        function(){ return request("ui/open-link", { url: url }); },
        function(){
          var r = openaiHost.openLink(url); if (r !== false) return r;
          var w = window.open(url, "_blank", "noopener,noreferrer"); return !!w;
        });
    },
    // Resolves to the tool's result object (true when a path gave none back), false when
    // no path exists, or "pending" when the host did not answer in time (the write may
    // have run, so it is never sent again). A host error comes back as an isError result.
    callTool: function(name, args){
      var keep = function(v){ return (v && typeof v === "object") ? v : true; };
      return primaryOr(
        function(){ return request("tools/call", { name: name, arguments: args || {} }, CALL_TIMEOUT_MS); },
        function(){ return openaiHost.callTool(name, args); },
        keep,
        function(err){
          if (err && err.timeout) return "pending";
          return { isError: true, content: [{ type: "text", text: (err && err.message) || "error" }] };
        });
    },
    canFullscreen: function(){ return displayModesOffered().indexOf("fullscreen") !== -1; },
    requestFullscreen: function(){ return displayMode("fullscreen"); },
    requestInline: function(){ return displayMode("inline"); }
  };
  connect();
})();
`;

export interface CardPageParts {
  /** The document title (not shown in the card). */
  title: string;
  /** Extra CSS for this card only. */
  css?: string;
  /** The card's static markup: ids and classes only, no data, no inline handlers. */
  body: string;
  /** The card's script: reads `window.PelarisCard`, draws with textContent. */
  script: string;
  /** The payload the page accepts: its card id and data version (added by the shell's `defineCard`). */
  card: { id: string; v: number };
  /** Display modes the card supports (MCP Apps `availableDisplayModes`). Default inline only. */
  displayModes?: ReadonlyArray<"inline" | "fullscreen" | "pip">;
}

/** Builds a complete, self-contained card page. */
export function renderCardPage(parts: CardPageParts): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<meta http-equiv="Content-Security-Policy" content="${CARD_PAGE_CSP}">`,
    `<title>${parts.title}</title>`,
    `<style>${CARD_BASE_CSS}${parts.css ?? ""}</style>`,
    "</head>",
    "<body>",
    parts.body,
    `<script>window.PELARIS_CARD_DISPLAY_MODES=${JSON.stringify(parts.displayModes ?? ["inline"])};` +
      `window.PELARIS_CARD_ACCEPTS=${JSON.stringify({ card: parts.card.id, v: parts.card.v })};</script>`,
    `<script>${CARD_BRIDGE_JS}</script>`,
    `<script>${parts.script}</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}
