import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "../firestore-client.js";

const COLLECTION = "pipeline_items";

export function registerPipelineTools(server: McpServer): void {
  server.tool(
    "list_pipeline_items",
    "List content pipeline items, optionally filtered by status or type.",
    {
      status: z
        .string()
        .optional()
        .describe("Filter by status: draft, review, approved, published"),
      type: z.string().optional().describe("Filter by content type"),
      limit: z.number().optional().default(20).describe("Max results (default 20)"),
    },
    async ({ status, type, limit }) => {
      try {
        let query: FirebaseFirestore.Query = db.collection(COLLECTION);

        if (status) query = query.where("status", "==", status);
        if (type) query = query.where("type", "==", type);
        query = query.orderBy("updatedAt", "desc").limit(limit);

        const snapshot = await query.get();
        const docs = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
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
    "get_pipeline_item",
    "Get a single content pipeline item by ID.",
    {
      id: z.string().describe("Pipeline item document ID"),
    },
    async ({ id }) => {
      try {
        const doc = await db.collection(COLLECTION).doc(id).get();
        if (!doc.exists) {
          return {
            content: [{ type: "text" as const, text: `Pipeline item "${id}" not found` }],
            isError: true,
          };
        }
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ id: doc.id, ...doc.data() }, null, 2) },
          ],
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
    "write_pipeline_item",
    "Create or update a content pipeline item. Provide an ID to update, omit to create.",
    {
      id: z.string().optional().describe("Document ID (omit to auto-generate)"),
      title: z.string().describe("Content title"),
      type: z.string().describe("Content type (e.g., blog, social, email)"),
      status: z
        .string()
        .optional()
        .default("draft")
        .describe("Status: draft, review, approved, published"),
      content: z.string().optional().describe("Content body"),
      metadata: z
        .object({
          targetPlatform: z.string().optional(),
          targetAudience: z.string().optional(),
          seoKeywords: z.array(z.string()).optional(),
        })
        .optional()
        .describe("Content metadata"),
      researchCacheId: z
        .string()
        .optional()
        .describe("Link to research_cache document"),
    },
    async ({ id, title, type, status, content, metadata, researchCacheId }) => {
      try {
        const now = new Date().toISOString();
        const data: Record<string, unknown> = {
          title,
          type,
          status: status || "draft",
          content: content || "",
          metadata: metadata || {},
          researchCacheId: researchCacheId || null,
          updatedAt: now,
        };

        let docRef;
        if (id) {
          docRef = db.collection(COLLECTION).doc(id);
          await docRef.set(data, { merge: true });
        } else {
          data.createdAt = now;
          docRef = await db.collection(COLLECTION).add(data);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Pipeline item saved. Document ID: ${docRef.id}`,
            },
          ],
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
