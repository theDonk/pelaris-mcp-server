/**
 * A small, dependency-free page harness for card tests: runs a card page's inline
 * scripts (the bridge and the card) in a Node `vm` context with a fake `window`,
 * `document` and parent frame. The fake DOM covers only what the card scripts use
 * (ids, classes, attributes, textContent, children, click and other listeners), and
 * the stub host answers the bridge's JSON-RPC requests the way a test says.
 *
 * Not a browser: layout, CSS and canvas are out of scope. Timers are manual, so a
 * test can make a request time out without waiting.
 */

import vm from "node:vm";

type Listener = (ev: FakeEvent) => void;
interface FakeEvent {
  type: string;
  preventDefault: () => void;
  [k: string]: unknown;
}

export class FakeElement {
  tagName: string;
  attrs: Record<string, string> = {};
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  listeners: Record<string, Listener[]> = {};
  dataset: Record<string, string> = {};
  style = { setProperty: (_k: string, _v: string) => undefined };
  disabled = false;
  type = "";
  title = "";
  private ownText = "";
  private classes = new Set<string>();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get id(): string {
    return this.attrs.id ?? "";
  }
  get className(): string {
    return [...this.classes].join(" ");
  }
  set className(v: string) {
    this.classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get classList() {
    const set = this.classes;
    return {
      add: (c: string) => void set.add(c),
      remove: (c: string) => void set.delete(c),
      contains: (c: string) => set.has(c),
      toggle: (c: string, on?: boolean) => {
        const want = on === undefined ? !set.has(c) : !!on;
        if (want) set.add(c);
        else set.delete(c);
        return want;
      },
    };
  }
  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.ownText = v == null ? "" : String(v);
    this.children = [];
  }
  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
  setAttribute(k: string, v: string): void {
    if (k === "class") this.className = v;
    else this.attrs[k] = String(v);
  }
  getAttribute(k: string): string | null {
    return k in this.attrs ? this.attrs[k] : null;
  }
  removeAttribute(k: string): void {
    delete this.attrs[k];
  }
  append(...nodes: FakeElement[]): void {
    for (const n of nodes) {
      n.parent = this;
      this.children.push(n);
    }
  }
  replaceChildren(...nodes: FakeElement[]): void {
    this.children = [];
    this.ownText = "";
    this.append(...nodes);
  }
  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ??= []).push(fn);
  }
  dispatch(type: string, extra: Record<string, unknown> = {}): void {
    const ev: FakeEvent = { type, preventDefault: () => undefined, ...extra };
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
  click(): void {
    if (this.disabled) return; // a disabled button takes no click, as in a browser
    this.dispatch("click");
  }
  focus(): void {
    /* no focus model */
  }
  /** Every element below this one, depth first. */
  all(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  /** Shown means neither it nor any parent carries pc-hidden. */
  get shown(): boolean {
    for (let e: FakeElement | null = this; e; e = e.parent) if (e.classList.contains("pc-hidden")) return false;
    return true;
  }
}

/** Builds the static elements from a card body's markup, nested by their tags. */
function parseBody(markup: string): FakeElement {
  const root = new FakeElement("body");
  const stack: FakeElement[] = [root];
  const voids = new Set(["br", "img", "input", "meta", "hr"]);
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  const clean = markup.replace(/<!--[\s\S]*?-->/g, "");
  while ((m = tagRe.exec(clean))) {
    if (m[4] !== undefined) {
      const t = m[4].trim();
      if (t) {
        const top = stack[stack.length - 1];
        if (!top.children.length) top.textContent = top.textContent + t;
      }
      continue;
    }
    const [, close, tag, rest] = m;
    if (close) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const el = new FakeElement(tag);
    for (const a of rest.matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) {
      const [, k, v] = a;
      if (k === "type") el.type = v ?? "";
      el.setAttribute(k, v ?? "");
    }
    stack[stack.length - 1].append(el);
    if (!voids.has(tag.toLowerCase()) && !rest.trim().endsWith("/")) stack.push(el);
  }
  return root;
}

export type HostReply = { result: unknown } | { error: { code: number; message: string } } | "silent";

export interface PageOptions {
  /** The stub host. Omit for a page with no parent frame at all. */
  host?: (method: string, params: Record<string, unknown>) => HostReply;
  /** The `ui/initialize` hostContext. */
  hostContext?: Record<string, unknown>;
  /** A fake `window.openai` runtime. */
  openai?: Record<string, unknown>;
}

export interface CardPage {
  $: (id: string) => FakeElement;
  /** Every JSON-RPC message the card posted to the host. */
  sent: Array<{ id?: number; method: string; params: Record<string, unknown> }>;
  /** Sends a notification from the host to the card. */
  notify: (method: string, params: unknown) => void;
  /** Runs every timer that is due (or all of them). */
  runTimers: () => void;
  /** Lets pending promises and host replies settle. */
  settle: () => Promise<void>;
  body: FakeElement;
  /** Every text drawn on a canvas, in order. */
  canvasTexts: string[];
}

export async function openCardPage(html: string, opts: PageOptions = {}): Promise<CardPage> {
  const bodyMarkup = html.slice(html.indexOf("<body>") + 6, html.indexOf("<script>"));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const body = parseBody(bodyMarkup);
  const docEl = new FakeElement("html");
  const winListeners: Record<string, Listener[]> = {};
  const sent: CardPage["sent"] = [];
  const canvasTexts: string[] = [];
  let timers: Array<{ id: number; fn: () => void }> = [];
  let timerId = 1;

  const byId = (id: string): FakeElement | null => body.all().find((e) => e.id === id) ?? null;
  const document = {
    documentElement: docEl,
    body,
    getElementById: byId,
    createElement: (tag: string) => {
      const e = new FakeElement(tag);
      if (tag === "canvas") {
        // A recording 2d context: text is kept in order; a character is 25 px wide.
        const ctx2d = {
          fillText: (t: string) => void canvasTexts.push(String(t)),
          measureText: (t: string) => ({ width: String(t).length * 25 }),
          fillRect: () => undefined,
        };
        Object.assign(e, { getContext: () => ctx2d, toDataURL: () => "data:image/png;base64,AA" });
      }
      if (tag === "a" || tag === "img") Object.assign(e, { remove: () => undefined });
      return e;
    },
    querySelectorAll: (sel: string) => {
      const cls = sel.startsWith(".") ? sel.slice(1) : null;
      return cls ? body.all().filter((e) => e.classList.contains(cls)) : [];
    },
  };

  const win: Record<string, unknown> = {};
  const toCard = (data: unknown) => {
    for (const fn of winListeners.message ?? []) fn({ type: "message", preventDefault: () => undefined, source: parent, data });
  };
  const parent = opts.host
    ? {
        postMessage: (msg: { id?: number; method: string; params: Record<string, unknown> }) => {
          sent.push(msg);
          if (msg.id == null) return;
          const reply: HostReply =
            msg.method === "ui/initialize"
              ? { result: { protocolVersion: "2026-01-26", hostCapabilities: {}, hostContext: opts.hostContext ?? {} } }
              : opts.host!(msg.method, msg.params);
          if (reply === "silent") return;
          queueMicrotask(() => toCard({ jsonrpc: "2.0", id: msg.id, ...reply }));
        },
      }
    : null;

  Object.assign(win, {
    window: win,
    parent: parent ?? win,
    document,
    openai: opts.openai,
    addEventListener: (type: string, fn: Listener) => void (winListeners[type] ??= []).push(fn),
    open: () => null,
    setTimeout: (fn: () => void) => {
      const id = timerId++;
      timers.push({ id, fn });
      return id;
    },
    clearTimeout: (id: number) => {
      timers = timers.filter((t) => t.id !== id);
    },
    queueMicrotask,
    console,
  });
  const ctx = vm.createContext(win);
  for (const src of scripts) vm.runInContext(src, ctx);

  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  };
  await settle();
  return {
    $: (id: string) => {
      const e = byId(id);
      if (!e) throw new Error(`no element #${id}`);
      return e;
    },
    sent,
    notify: (method, params) => toCard({ jsonrpc: "2.0", method, params }),
    runTimers: () => {
      const due = timers;
      timers = [];
      due.forEach((t) => t.fn());
    },
    settle,
    body,
    canvasTexts,
  };
}
