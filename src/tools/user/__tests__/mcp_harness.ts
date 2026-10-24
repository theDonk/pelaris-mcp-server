/**
 * Test harness (not a test file): runs a REAL McpServer with one registered tool and a REAL MCP client over the
 * SDK's in-memory transport, inside `runWithAuth`, so a test sees what an assistant sees: the argument
 * validator (stale arguments stripped), the registered schema and annotations, and the handler's reply.
 * No network, no Firestore: the tools under test take their reads as injected dependencies.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpTokenClaims } from "../../../auth.js";
import { runWithAuth } from "../../../request-context.js";

export interface ToolReply {
  isError: boolean;
  text: string;
}

export const TEST_CLAIMS: McpTokenClaims = {
  sub: "pseudonym_test",
  scope: "training:read training:write",
  platform: "test",
  profile_id: "profile_test_1",
  exp: 0,
  iat: 0,
};

export interface ToolSession {
  client: Client;
  listedTool: (name: string) => Promise<Record<string, unknown> | undefined>;
  call: (name: string, args: Record<string, unknown>, claims?: McpTokenClaims | null) => Promise<ToolReply>;
  close: () => Promise<void>;
}

export async function openToolSession(register: (server: McpServer) => void): Promise<ToolSession> {
  const server = new McpServer({ name: "test-gateway", version: "0.0.0" });
  register(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-assistant", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    listedTool: async (name) => {
      const { tools } = await client.listTools();
      return tools.find((tool) => tool.name === name) as Record<string, unknown> | undefined;
    },
    call: async (name, args, claims = TEST_CLAIMS) => {
      const result = (await runWithAuth(claims, () => client.callTool({ name, arguments: args }))) as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
      return { isError: result.isError === true, text: result.content[0].text };
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export interface CapturedLog {
  message?: string;
  tool?: string;
  userPseudonym?: string;
  success?: boolean;
  error?: string;
  [key: string]: unknown;
}

/**
 * Collects the gateway's own structured log lines (`{"severity":...}`) written during `fn`, and hides them from
 * the test output. Anything else written to stdout (the test runner's own events) passes through untouched.
 */
export async function captureLogs<T>(fn: () => Promise<T>): Promise<{ value: T; logs: CapturedLog[] }> {
  const logs: CapturedLog[] = [];
  const write = process.stdout.write.bind(process.stdout) as (chunk: unknown, ...rest: unknown[]) => boolean;
  (process.stdout as unknown as { write: (chunk: unknown, ...rest: unknown[]) => boolean }).write = (chunk, ...rest) => {
    if (typeof chunk === "string" && chunk.startsWith('{"severity"')) {
      for (const line of chunk.split("\n")) if (line.length > 0) logs.push(JSON.parse(line) as CapturedLog);
      return true;
    }
    return write(chunk, ...rest);
  };
  try {
    return { value: await fn(), logs };
  } finally {
    (process.stdout as unknown as { write: typeof write }).write = write;
  }
}

/** True when the text holds an en dash or an em dash (Brad's voice rule: none in copy a person reads). */
export function hasDash(text: string): boolean {
  return text.includes(String.fromCharCode(0x2013)) || text.includes(String.fromCharCode(0x2014));
}
