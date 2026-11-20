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
 *
 * The host: cards are on for a request only when the switch is on AND the host draws
 * MCP Apps (`cardsOn`, from the host adapter in host.ts). A text-only host gets no card
 * resources, no `_meta.ui` on tools, no card data and no signed link minted for a card.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CARDS_UI_DOMAIN_ENV,
  MCP_APP_MIME_TYPE,
  MCP_APPS_EXTENSION_ID,
  currentHostProfile,
  type HostProfile,
} from "./host.js";

export { CARDS_UI_DOMAIN_ENV, MCP_APP_MIME_TYPE, MCP_APPS_EXTENSION_ID };
export type { HostProfile };

/** MCP Apps spec version the shell was built against. */
export const MCP_APPS_SPEC_VERSION = "2026-01-26";

/** Result `_meta` key the card data rides under. The card reads this key only. */
export const CARD_DATA_META_KEY = "pelaris/card";

/** Environment switch. */
export const CARDS_ENV_FLAG = "PELARIS_CARDS";

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

/**
 * The one gate for card work on a request: the switch is on and the host draws cards.
 * Every card helper and every mint of a card's link goes through it.
 */
export function cardsOn(host: HostProfile = currentHostProfile(), env: NodeJS.ProcessEnv = process.env): boolean {
  return cardsEnabled(env) && host.supportsCards;
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
 * The `_meta` to spread into a tool definition so hosts link the tool to its card, or
 * `undefined` when cards are off for this host. Only the standard nested key: the flat
 * `ui/resourceUri` key is deprecated in the spec (to be removed before GA) and no host
 * this server supports documents needing it. Tools are registered per request (the
 * transport is stateless), so a text-only host lists the tool as a plain tool, which the
 * spec allows ("Servers MAY register different tool variants based on host capabilities").
 */
export function cardToolMeta(
  card: CardDefinition,
  env: NodeJS.ProcessEnv = process.env,
  host: HostProfile = currentHostProfile(env),
): Record<string, unknown> | undefined {
  if (!cardsOn(host, env)) return undefined;
  return { ui: { resourceUri: card.resourceUri } };
}

/**
 * The `_meta` for a tool a card calls itself through the bridge, or `undefined` when
 * cards are off for this host. `visibility: ["app"]`: the card may call it, and the spec
 * says a host MUST NOT include it in the model's tool list. Host-specific keys come from the
 * host adapter (ChatGPT's `openai/widgetAccessible`). The tool's annotations are
 * unchanged, and the host still applies its own approval to a write.
 */
export function cardCallableToolMeta(
  env: NodeJS.ProcessEnv = process.env,
  host: HostProfile = currentHostProfile(env),
): Record<string, unknown> | undefined {
  if (!cardsOn(host, env)) return undefined;
  return { ui: { visibility: ["app"] }, ...host.appToolMeta };
}

/** The resource-level `_meta.ui`: strict CSP (no outside origins at all), a border, and the host's sandbox origin when it has one. */
export function cardResourceMeta(
  env: NodeJS.ProcessEnv = process.env,
  host: HostProfile = currentHostProfile(env),
): Record<string, unknown> {
  return {
    ui: {
      csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
      prefersBorder: true,
      ...(host.uiDomain ? { domain: host.uiDomain } : {}),
    },
  };
}

/** Registers every card's `ui://` resource. Does nothing when cards are off for this host. */
export function registerCardResources(
  server: McpServer,
  cards: readonly CardDefinition[],
  env: NodeJS.ProcessEnv = process.env,
  host: HostProfile = currentHostProfile(env),
): void {
  if (!cardsOn(host, env)) return;
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
            _meta: cardResourceMeta(env, host),
          },
        ],
      }),
    );
  }
}

/**
 * Returns `result` with the card's data added under `_meta["pelaris/card"]`. Leaves the
 * result untouched when cards are off for this host, when there is no data, or when it
 * is an error.
 */
export function withCard<T extends { content: unknown[]; isError?: boolean; _meta?: Record<string, unknown> }>(
  result: T,
  card: CardDefinition,
  data: Record<string, unknown> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  host: HostProfile = currentHostProfile(env),
): T & { _meta?: Record<string, unknown> } {
  if (!cardsOn(host, env) || !data || result.isError) return result;
  const picked = pickCardFields(data, card.fields);
  if (Object.keys(picked).length === 0) return result;
  return {
    ...result,
    _meta: { ...(result._meta ?? {}), [CARD_DATA_META_KEY]: { card: card.id, ...picked } },
  };
}
