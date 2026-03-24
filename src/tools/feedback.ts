import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "../firestore-client.js";
import { scrubDocument } from "../scrubber.js";

const COLLECTION = "feedback";

export function registerFeedbackTools(server: McpServer): void {
  server.tool(
    "list_feedback",
    "List user feedback entries. PII is automatically scrubbed from the response.",
    {
      limit: z.number().optional().default(20).describe("Max results (default 20)"),
    },
    async ({ limit }) => {
      try {
        const snapshot = await db
          .collection(COLLECTION)
          .orderBy("createdAt", "desc")
          .limit(limit)
          .get();

        const docs = snapshot.docs.map((doc) =>
          scrubDocument({ id: doc.id, ...doc.data() } as Record<string, unknown>)
        );

        return {
          content: [{ type: "text" as const, text: JSON.stringify(docs, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_feedback_item",
    "Get a single feedback entry by ID. PII is automatically scrubbed.",
    {
      id: z.string().describe("Feedback document ID"),
    },
    async ({ id }) => {
      try {
        const doc = await db.collection(COLLECTION).doc(id).get();
        if (!doc.exists) {
          return {
            content: [{ type: "text" as const, text: `Feedback "${id}" not found` }],
            isError: true,
          };
        }

        const scrubbed = scrubDocument({ id: doc.id, ...doc.data() } as Record<string, unknown>);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(scrubbed, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }],
          isError: true,
        };
      }
    }
  );
}
