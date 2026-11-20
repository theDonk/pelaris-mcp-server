/**
 * Card shell tests (node:test). Run after build.
 *
 * Proves: each card's ui:// resource is registered with the MCP Apps MIME type and a
 * strict CSP; a tool definition carries _meta.ui.resourceUri; card data lands in the
 * result's _meta with only allow-listed fields while the text stays the same; and the
 * PELARIS_CARDS switch turns all of it off.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const {
  CARD_DATA_META_KEY,
  MCP_APP_MIME_TYPE,
  cardResourceMeta,
  cardToolMeta,
  cardsEnabled,
  pickCardFields,
  withCard,
} = await import("../card_shell.js");
const { CARDS, registerCards } = await import("../registry.js");
const { SESSION_CARD } = await import("../session_card.js");
const { hostProfileFrom, TEXT_ONLY_HOST } = await import("../host.js");
const { runWithConnectorFacts } = await import("../../connector/connector_use.js");

/** A card host with no sandbox domain (the override set to none), and ChatGPT. */
const CARD_HOST = hostProfileFrom({ assistantClass: "chatgpt" }, {});
const CLAUDE = hostProfileFrom({ assistantClass: "claude" }, {});
const { registerGetSessionDetails } = await import("../../tools/user/get_session_details.js");

const ON: NodeJS.ProcessEnv = {};
const OFF: NodeJS.ProcessEnv = { PELARIS_CARDS: "off" };

async function connect(register: (server: McpServer) => void) {
  const server = new McpServer({ name: "test-gateway", version: "0.0.0" });
  register(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-host", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

test("the switch: on by default, off for off/0/false/no", () => {
  assert.equal(cardsEnabled({}), true);
  assert.equal(cardsEnabled({ PELARIS_CARDS: "on" }), true);
  for (const v of ["off", "0", "false", "no", " OFF "]) assert.equal(cardsEnabled({ PELARIS_CARDS: v }), false, v);
});

test("every card's ui:// resource is registered with the MCP Apps MIME type and strict CSP", async () => {
  const { client, close } = await connect((server) => registerCards(server, ON, CARD_HOST));
  try {
    const { resources } = await client.listResources();
    for (const card of CARDS) {
      assert.ok(card.resourceUri.startsWith("ui://"), card.resourceUri);
      const listed = resources.find((r) => r.uri === card.resourceUri);
      assert.ok(listed, `${card.id} listed`);
      assert.equal(listed.mimeType, MCP_APP_MIME_TYPE);
      const read = await client.readResource({ uri: card.resourceUri });
      const content = read.contents[0] as { mimeType?: string; text?: string; _meta?: Record<string, unknown> };
      assert.equal(content.mimeType, "text/html;profile=mcp-app");
      assert.match(content.text ?? "", /^<!doctype html>/);
      const ui = content._meta?.ui as { csp: Record<string, unknown[]>; prefersBorder: boolean; domain?: string };
      assert.deepEqual(ui.csp, { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] });
      assert.equal(ui.prefersBorder, true);
      assert.equal(ui.domain, undefined, "ChatGPT gets no sandbox domain");
    }
  } finally {
    await close();
  }
});

test("the sandbox domain is per host; the env value overrides it, and none removes it", () => {
  const claudeDomain = (cardResourceMeta({}, CLAUDE).ui as { domain?: string }).domain;
  assert.match(claudeDomain ?? "", /^[0-9a-f]{32}\.claudemcpcontent\.com$/, "Claude's documented format");
  assert.equal((cardResourceMeta({}, CARD_HOST).ui as { domain?: string }).domain, undefined);
  const env = { PELARIS_CARDS_UI_DOMAIN: "example-sandbox.invalid" };
  assert.equal((cardResourceMeta(env, hostProfileFrom({ assistantClass: "claude" }, env)).ui as { domain: string }).domain, "example-sandbox.invalid");
  const none = { PELARIS_CARDS_UI_DOMAIN: "none" };
  assert.equal((cardResourceMeta(none, hostProfileFrom({ assistantClass: "claude" }, none)).ui as { domain?: string }).domain, undefined);
});

test("off: no card resources are registered", async () => {
  const { client, close } = await connect((server) => {
    // A plain resource so the server still has the resources capability.
    server.registerResource("other", "pelaris://test/other", { mimeType: "text/plain" }, async () => ({
      contents: [{ uri: "pelaris://test/other", text: "x" }],
    }));
    registerCards(server, OFF, CARD_HOST);
  });
  try {
    const { resources } = await client.listResources();
    assert.deepEqual(resources.map((r) => r.uri), ["pelaris://test/other"]);
  } finally {
    await close();
  }
});

test("tool meta names the card resource (nested key only), and is absent when off or for a text-only host", () => {
  assert.deepEqual(cardToolMeta(SESSION_CARD, ON, CARD_HOST), { ui: { resourceUri: SESSION_CARD.resourceUri } });
  assert.equal(cardToolMeta(SESSION_CARD, OFF, CARD_HOST), undefined);
  assert.equal(cardToolMeta(SESSION_CARD, ON, TEXT_ONLY_HOST), undefined);
});

test("get_session_details is listed with the Session card's resourceUri", async () => {
  const { client, close } = await connect((server) =>
    runWithConnectorFacts({ profileId: "profile_test", clientClass: "claude" }, () => registerGetSessionDetails(server)));
  try {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "get_session_details") as { _meta?: { ui?: { resourceUri?: string } } };
    assert.equal(tool._meta?.ui?.resourceUri, SESSION_CARD.resourceUri);
  } finally {
    await close();
  }
});

test("a text-only host lists get_session_details as a plain tool and gets no card resources", async () => {
  for (const clientClass of ["other", "unknown", "grok"] as const) {
    const { client, close } = await connect((server) =>
      runWithConnectorFacts({ profileId: "profile_test", clientClass }, () => {
        server.registerResource("other", "pelaris://test/other", { mimeType: "text/plain" }, async () => ({
          contents: [{ uri: "pelaris://test/other", text: "x" }],
        }));
        registerGetSessionDetails(server);
        registerCards(server);
      }));
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === "get_session_details") as { _meta?: Record<string, unknown> };
      assert.equal(tool._meta, undefined, clientClass);
      const { resources } = await client.listResources();
      assert.deepEqual(resources.map((r) => r.uri), ["pelaris://test/other"], clientClass);
    } finally {
      await close();
    }
  }
});

test("withCard adds only allow-listed fields under _meta and leaves the text alone", () => {
  const reply = { content: [{ type: "text" as const, text: "{\"title\":\"Sample\"}" }] };
  const out = withCard(
    reply,
    SESSION_CARD,
    {
      title: "Sample",
      rows: [{ name: "Goblet squat", detail: "3 x 8", exerciseId: "ex_secret", sets: [{ a: 1 }] }],
      sessionId: "session_sample_1",
      bodyPhotoUrl: "https://example.invalid/photo.jpg",
      startUrl: "https://example.invalid/start",
      nested: { anything: true },
    },
    ON,
    CARD_HOST,
  );
  assert.deepEqual(out.content, reply.content, "text unchanged");
  assert.deepEqual(out._meta?.[CARD_DATA_META_KEY], {
    card: "session",
    title: "Sample",
    rows: [{ name: "Goblet squat", detail: "3 x 8" }],
    startUrl: "https://example.invalid/start",
  });
});

test("withCard does nothing when off, with no data, or on an error", () => {
  const reply = { content: [{ type: "text" as const, text: "x" }] };
  assert.equal(withCard(reply, SESSION_CARD, { title: "Sample" }, OFF, CARD_HOST), reply);
  assert.equal(withCard(reply, SESSION_CARD, { title: "Sample" }, ON, TEXT_ONLY_HOST), reply, "text-only host");
  assert.equal(withCard(reply, SESSION_CARD, { title: "Sample" }, ON), reply, "no request facts: no cards");
  assert.equal(withCard(reply, SESSION_CARD, null, ON, CARD_HOST), reply);
  assert.equal(withCard(reply, SESSION_CARD, { unknown: 1 }, ON, CARD_HOST), reply);
  const err = { ...reply, isError: true };
  assert.equal(withCard(err, SESSION_CARD, { title: "Sample" }, ON, CARD_HOST), err);
});

test("pickCardFields never lets an object through a scalar spec", () => {
  assert.deepEqual(pickCardFields({ a: { deep: 1 }, b: [1, 2], c: "ok" }, { a: true, b: true, c: true }), { c: "ok" });
});

test("a card's URI comes from its page: a changed page gives a new URI", async () => {
  const { cardResourceUri, defineCard } = await import("../card_shell.js");
  const a = cardResourceUri("sample", "<p>one</p>");
  assert.match(a, /^ui:\/\/pelaris\/cards\/sample-[0-9a-f]{10}\.html$/);
  assert.equal(cardResourceUri("sample", "<p>one</p>"), a, "same page, same URI");
  assert.notEqual(cardResourceUri("sample", "<p>two</p>"), a, "changed page, new URI");
  const def = defineCard({ id: "sample", title: "t", description: "d", fields: {}, page: () => "<p>one</p>" });
  assert.equal(def.resourceUri, a);
  assert.equal(def.html(), "<p>one</p>");
});

test("all four card URIs are distinct and stable across two loads", async () => {
  const first = CARDS.map((c) => c.resourceUri);
  assert.equal(new Set(first).size, CARDS.length, "distinct");
  for (const card of CARDS) {
    assert.match(card.resourceUri, new RegExp(`^ui://pelaris/cards/${card.id}-[0-9a-f]{10}\.html$`));
  }
  // A second load in a fresh Node process (new module instances) gives the same URIs.
  const { spawnSync } = await import("node:child_process");
  const registryUrl = new URL("../registry.js", import.meta.url).href;
  const script = `const m = await import(${JSON.stringify(registryUrl)}); console.log(JSON.stringify(m.CARDS.map((c) => c.resourceUri)));`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim().split("\n").pop() ?? "[]"), first, "stable");
});
