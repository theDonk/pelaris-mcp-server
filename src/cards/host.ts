/**
 * Host adapter: the one place that knows which assistant host is on the other end and
 * what it needs for cards. Everything host-specific on the server side lives here.
 *
 * Why a host profile: the MCP Apps spec says a server SHOULD check the client's
 * `capabilities.extensions["io.modelcontextprotocol/ui"]` before offering UI, and give
 * a text-only fallback otherwise. A host that cannot draw a card should cost nothing:
 * no `ui://` resources, no `_meta.ui` on tools, no card data on results and no signed
 * link written for a card nobody will see.
 *
 * Where the facts come from. This server runs the Streamable HTTP transport stateless
 * (a new server per POST /mcp, see src/index.ts), so the client's `initialize`
 * capabilities and `clientInfo` reach only the server that answers `initialize`; a later
 * `tools/list` or `tools/call` is answered by a fresh server that never saw them. What
 * every request does carry is the OAuth token, and the token's stored assistant class
 * (set once at consent from the validated redirect host, see
 * src/connector/token_access.ts). So:
 * 1. a declared MCP Apps capability (`mimeTypes` naming the card MIME type) means cards,
 *    when the caller has it (a stateful transport, or a test);
 * 2. otherwise the host's name (the token's assistant class, or `clientInfo.name` when
 *    known) must be on `CARD_HOSTS`, the one explicit allow-list;
 * 3. anything else, including an unknown or missing host, means no card work.
 *
 * Neither the Claude nor the ChatGPT docs (read Fri 20 Nov 2026) state whether the host
 * advertises the extension capability in `initialize`, which is why the allow-list
 * exists. Add a host to it only after its docs say it draws MCP Apps.
 */

import { createHash } from "node:crypto";
import { currentConnectorFacts } from "../connector/connector_use.js";

/** Extension id hosts negotiate MCP Apps under. */
export const MCP_APPS_EXTENSION_ID = "io.modelcontextprotocol/ui";

/** MIME type the MCP Apps spec requires for an HTML card resource. */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/** This server's public MCP endpoint (public: it is in the OAuth metadata too). */
export const PUBLIC_MCP_URL = "https://api.pelaris.io/mcp";

/**
 * Optional override for the card's sandbox origin (`_meta.ui.domain`). Set to a value to
 * use it for every card host, or to `none` to send no domain at all. Unset: each host's
 * own rule in `CARD_HOSTS`.
 */
export const CARDS_UI_DOMAIN_ENV = "PELARIS_CARDS_UI_DOMAIN";

export interface HostProfile {
  /** True when this host draws MCP Apps cards. */
  supportsCards: boolean;
  /** The host's short name (`claude`, `chatgpt`, ...), or `unknown`. */
  name: string;
  /** How `supportsCards` was decided. */
  source: "capability" | "allow-list" | "none";
  /** The card resource's `_meta.ui.domain` for this host, when it has one. */
  uiDomain?: string;
  /** Extra `_meta` keys this host asks for on a tool a card may call. */
  appToolMeta: Record<string, unknown>;
}

interface CardHostRule {
  /** The host's sandbox origin rule, given this server's public URL. */
  uiDomain?: (serverUrl: string) => string;
  /** Host-specific keys for a tool the card calls. */
  appToolMeta?: Record<string, unknown>;
}

/**
 * The one allow-list of hosts that draw MCP Apps cards, keyed by host name (the token's
 * assistant class). Sources:
 * - claude: "Get started with MCP Apps" (claude.com/docs/connectors/building/mcp-apps),
 *   including the `ui.domain` rule: the first 32 hex characters of the SHA-256 of the
 *   server URL, then `.claudemcpcontent.com`.
 * - chatgpt: "Build the ChatGPT UI" (developers.openai.com/plugins/build/chatgpt-ui):
 *   the standard `_meta.ui.resourceUri` and bridge. `openai/widgetAccessible` is
 *   ChatGPT's older key for a tool its widget may call; kept here, harmless elsewhere.
 * Anything not named here gets no card work.
 */
export const CARD_HOSTS: Readonly<Record<string, CardHostRule>> = Object.freeze({
  claude: {
    uiDomain: (serverUrl: string) =>
      createHash("sha256").update(serverUrl).digest("hex").slice(0, 32) + ".claudemcpcontent.com",
  },
  chatgpt: {
    appToolMeta: { "openai/widgetAccessible": true },
  },
});

/** A host that gets no card work. */
export const TEXT_ONLY_HOST: HostProfile = Object.freeze({
  supportsCards: false,
  name: "unknown",
  source: "none",
  appToolMeta: Object.freeze({}) as Record<string, unknown>,
}) as HostProfile;

export interface HostFacts {
  /** The client's `initialize` capabilities, when this server saw them. */
  capabilities?: { extensions?: Record<string, unknown> } & Record<string, unknown>;
  /** The client's `initialize` clientInfo, when this server saw it. */
  clientInfo?: { name?: string } | null;
  /** The OAuth token's stored assistant class (`claude`, `chatgpt`, ..., `unknown`). */
  assistantClass?: string | null;
}

/** True when the declared capabilities say the client draws MCP Apps HTML. */
export function declaresCardCapability(capabilities: HostFacts["capabilities"]): boolean {
  const ext = capabilities?.extensions?.[MCP_APPS_EXTENSION_ID];
  if (!ext || typeof ext !== "object") return false;
  const mimeTypes = (ext as { mimeTypes?: unknown }).mimeTypes;
  return Array.isArray(mimeTypes) && mimeTypes.includes(MCP_APP_MIME_TYPE);
}

function hostNameOf(facts: HostFacts): string {
  const cls = (facts.assistantClass ?? "").trim().toLowerCase();
  if (cls && cls !== "unknown" && cls !== "other") return cls;
  const info = (facts.clientInfo?.name ?? "").trim().toLowerCase();
  // clientInfo names vary by app ("claude-ai", "ChatGPT", ...): match a listed host's name.
  const listed = Object.keys(CARD_HOSTS).find((h) => info === h || info.startsWith(`${h}-`) || info.startsWith(`${h} `));
  return listed ?? (info || "unknown");
}

function uiDomainFor(rule: CardHostRule | undefined, env: NodeJS.ProcessEnv, serverUrl: string): string | undefined {
  const override = (env[CARDS_UI_DOMAIN_ENV] ?? "").trim();
  if (override.toLowerCase() === "none") return undefined;
  if (override) return override;
  return rule?.uiDomain?.(serverUrl);
}

/** Builds the host profile from whatever facts this request has. Pure. */
export function hostProfileFrom(
  facts: HostFacts,
  env: NodeJS.ProcessEnv = process.env,
  serverUrl: string = PUBLIC_MCP_URL,
): HostProfile {
  const name = hostNameOf(facts);
  const rule = Object.prototype.hasOwnProperty.call(CARD_HOSTS, name) ? CARD_HOSTS[name] : undefined;
  const declared = declaresCardCapability(facts.capabilities);
  if (!declared && !rule) return { ...TEXT_ONLY_HOST, name };
  const uiDomain = uiDomainFor(rule, env, serverUrl);
  return {
    supportsCards: true,
    name,
    source: declared ? "capability" : "allow-list",
    ...(uiDomain ? { uiDomain } : {}),
    appToolMeta: { ...(rule?.appToolMeta ?? {}) },
  };
}

/**
 * The host profile for the current request: the token's assistant class from the
 * request's connector facts. Admin-authed calls and calls with no facts get no cards.
 */
export function currentHostProfile(env: NodeJS.ProcessEnv = process.env): HostProfile {
  const facts = currentConnectorFacts();
  if (!facts) return TEXT_ONLY_HOST;
  return hostProfileFrom({ assistantClass: facts.clientClass }, env);
}
