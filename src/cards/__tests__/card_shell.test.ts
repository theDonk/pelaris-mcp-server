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
  const { client, close } = await connect((server) => registerCards(server, ON));
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
      assert.equal(ui.domain, undefined, "no sandbox domain unless one is configured");
    }
  } finally {
    await close();
  }
});

test("a configured sandbox domain is passed through", () => {
  const meta = cardResourceMeta({ PELARIS_CARDS_UI_DOMAIN: "example-sandbox.invalid" });
  assert.equal((meta.ui as { domain: string }).domain, "example-sandbox.invalid");
});

test("off: no card resources are registered", async () => {
  const { client, close } = await connect((server) => {
    // A plain resource so the server still has the resources capability.
    server.registerResource("other", "pelaris://test/other", { mimeType: "text/plain" }, async () => ({
      contents: [{ uri: "pelaris://test/other", text: "x" }],
    }));
    registerCards(server, OFF);
  });
  try {
    const { resources } = await client.listResources();
    assert.deepEqual(resources.map((r) => r.uri), ["pelaris://test/other"]);
  } finally {
    await close();
  }
});

test("tool meta names the card resource (nested and flat keys), and is absent when off", () => {
  assert.deepEqual(cardToolMeta(SESSION_CARD, ON), {
    ui: { resourceUri: SESSION_CARD.resourceUri },
    "ui/resourceUri": SESSION_CARD.resourceUri,
  });
  assert.equal(cardToolMeta(SESSION_CARD, OFF), undefined);
});

test("get_session_details is listed with the Session card's resourceUri", async () => {
  const { client, close } = await connect((server) => registerGetSessionDetails(server));
  try {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "get_session_details") as { _meta?: { ui?: { resourceUri?: string } } };
    assert.equal(tool._meta?.ui?.resourceUri, SESSION_CARD.resourceUri);
  } finally {
    await close();
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
  assert.equal(withCard(reply, SESSION_CARD, { title: "Sample" }, OFF), reply);
  assert.equal(withCard(reply, SESSION_CARD, null, ON), reply);
  assert.equal(withCard(reply, SESSION_CARD, { unknown: 1 }, ON), reply);
  const err = { ...reply, isError: true };
  assert.equal(withCard(err, SESSION_CARD, { title: "Sample" }, ON), err);
});

test("pickCardFields never lets an object through a scalar spec", () => {
  assert.deepEqual(pickCardFields({ a: { deep: 1 }, b: [1, 2], c: "ok" }, { a: true, b: true, c: true }), { c: "ok" });
});
