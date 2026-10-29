/**
 * The serverInfo a client sees (node:test): through a REAL MCP client over the
 * SDK's in-memory transport, `initialize` answers name and title "Pelaris", never the internal
 * package name, and the /mcp handler builds its server from `serverInfo`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { serverInfo } from "../server_info.js";

test("initialize answers serverInfo name and title Pelaris, with the given version", async () => {
  const server = new McpServer(serverInfo("9.9.9"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-assistant", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const info = client.getServerVersion();
    assert.equal(info?.name, "Pelaris");
    assert.equal(info?.title, "Pelaris");
    assert.equal(info?.version, "9.9.9");
  } finally {
    await client.close();
    await server.close();
  }
});

test("the /mcp handler builds its McpServer from serverInfo, not a literal name", () => {
  const source = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf-8");
  assert.ok(source.includes("new McpServer(serverInfo(VERSION)"), "index.ts uses serverInfo(VERSION)");
  assert.ok(!/new McpServer\(\{\s*name:/.test(source), "no inline serverInfo literal left in index.ts");
});
