/**
 * Card shell: the one place every Pelaris card goes through.
 *
 * A card is interactive UI an assistant host draws under a tool result, built on the
 * MCP Apps extension (`io.modelcontextprotocol/ui`, stable spec 2026-01-26). The shell:
 * - registers each card's `ui://` HTML resource with the MCP server;
 * - gives a tool definition the `_meta.ui.resourceUri` that links it to its card;
 * - adds the card's data to a tool result under `_meta["pelaris/card"]`, keeping only
 *   the fields the card's allow-list names.
 *
 * The result's `content` text (and `structuredContent`, where a tool has it) is never
 * changed, so hosts without card support, and the assistant itself, see exactly what
 * they saw before. Card data rides in `_meta`, which hosts hand to the card, not to
 * the model, so the model's view stays the full tool reply.
 *
 * The switch: `PELARIS_CARDS=off` (or `0`, `false`, `no`) turns every card off. It is
 * read each time a server is built and each time a result is shaped, so changing the
 * environment value is enough; no code path changes. Unset means on.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** MIME type the MCP Apps spec requires for an HTML card resource. */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/** Extension id hosts negotiate MCP Apps under. */
export const MCP_APPS_EXTENSION_ID = "io.modelcontextprotocol/ui";

/** MCP Apps spec version the shell was built against. */
export const MCP_APPS_SPEC_VERSION = "2026-01-26";

/** Result `_meta` key the card data rides under. The card reads this key only. */
export const CARD_DATA_META_KEY = "pelaris/card";

/** Environment switch. */
export const CARDS_ENV_FLAG = "PELARIS_CARDS";

/** Optional sandbox origin for hosts that ask for one (each host has its own format). */
export const CARDS_UI_DOMAIN_ENV = "PELARIS_CARDS_UI_DOMAIN";

/**
 * Allow-list for card data. `true` keeps a scalar value as it is. A nested spec keeps
 * an object with only those keys, or an array of such objects. Anything not named is
 * dropped, so a card can never be handed more than it shows.
 */
export type CardFieldSpec = true | { [key: string]: CardFieldSpec };
export type CardAllowList = { [key: string]: CardFieldSpec };

export interface CardDefinition {
  /** Short id, also used in the resource name. */
  id: string;
  /** `ui://` URI. Treat it as a cache key: bump its version after a breaking change. */
  resourceUri: string;
  /** Human name of the resource. */
  title: string;
  /** One line: what the card shows. */
  description: string;
  /** The fields the card is allowed to receive. */
  fields: CardAllowList;
  /** Builds the full HTML page (see templates.ts `renderCardPage`). */
  html: () => string;
}

export function cardsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[CARDS_ENV_FLAG] ?? "").trim().toLowerCase();
  return !["off", "0", "false", "no"].includes(raw);
}

function pickValue(value: unknown, spec: CardFieldSpec): unknown {
  if (spec === true) {
    // Scalars only: an object or array under a scalar spec is dropped, so a nested
    // value can never slip through without its own allow-list.
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
    return undefined;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => pickValue(item, spec))
      .filter((item) => item !== undefined);
  }
  if (value !== null && typeof value === "object") {
    return pickCardFields(value as Record<string, unknown>, spec);
  }
  return undefined;
}

/** Keeps only the allow-listed fields of `data`, recursively. */
export function pickCardFields(
  data: Record<string, unknown>,
  allow: CardAllowList,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(allow)) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    const picked = pickValue(data[key], spec);
    if (picked !== undefined) out[key] = picked;
  }
  return out;
}

/**
 * The `_meta` to spread into a tool definition so hosts link the tool to its card,
 * or `undefined` when cards are off. Carries the standard nested key and the flat
 * `ui/resourceUri` key that the official SDK helper also writes for older hosts.
 */
export function cardToolMeta(
  card: CardDefinition,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> | undefined {
  if (!cardsEnabled(env)) return undefined;
  return {
    ui: { resourceUri: card.resourceUri },
    "ui/resourceUri": card.resourceUri,
  };
}

/**
 * The `_meta` for a tool a card calls itself through the bridge (for example the Week
 * card's Confirm calling modify_training_session), or `undefined` when cards are off.
 * MCP Apps `visibility` names both the model and the card (the spec's default, stated
 * so it is explicit); ChatGPT asks for `openai/widgetAccessible` before a card may call
 * a tool. The tool's own annotations (read-only or destructive) are unchanged, and the
 * host still applies its own approval to a write.
 */
export function cardCallableToolMeta(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | undefined {
  if (!cardsEnabled(env)) return undefined;
  return { ui: { visibility: ["model", "app"] }, "openai/widgetAccessible": true };
}

/** The resource-level `_meta.ui`: strict CSP (no outside origins at all) and a border. */
export function cardResourceMeta(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const domain = (env[CARDS_UI_DOMAIN_ENV] ?? "").trim();
  return {
    ui: {
      csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
      prefersBorder: true,
      ...(domain ? { domain } : {}),
    },
  };
}

/** Registers every card's `ui://` resource. Does nothing when cards are off. */
export function registerCardResources(
  server: McpServer,
  cards: readonly CardDefinition[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!cardsEnabled(env)) return;
  for (const card of cards) {
    server.registerResource(
      `card_${card.id}`,
      card.resourceUri,
      { title: card.title, description: card.description, mimeType: MCP_APP_MIME_TYPE },
      async () => ({
        contents: [
          {
            uri: card.resourceUri,
            mimeType: MCP_APP_MIME_TYPE,
            text: card.html(),
            _meta: cardResourceMeta(env),
          },
        ],
      }),
    );
  }
}

/**
 * Returns `result` with the card's data added under `_meta["pelaris/card"]`. Leaves the
 * result untouched when cards are off, when there is no data, or when it is an error.
 */
export function withCard<T extends { content: unknown[]; isError?: boolean; _meta?: Record<string, unknown> }>(
  result: T,
  card: CardDefinition,
  data: Record<string, unknown> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): T & { _meta?: Record<string, unknown> } {
  if (!cardsEnabled(env) || !data || result.isError) return result;
  const picked = pickCardFields(data, card.fields);
  if (Object.keys(picked).length === 0) return result;
  return {
    ...result,
    _meta: { ...(result._meta ?? {}), [CARD_DATA_META_KEY]: { card: card.id, ...picked } },
  };
}
