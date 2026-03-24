import { z } from "zod";
import { db } from "../firestore-client.js";
const COLLECTION = "research_cache";
export function registerResearchTools(server) {
    server.tool("get_research", "Query research cache by topic. Returns cached research content, sources, and metadata.", {
        topic: z.string().describe("Topic to search for (exact or partial match)"),
    }, async ({ topic }) => {
        try {
            const snapshot = await db
                .collection(COLLECTION)
                .where("topic", "==", topic)
                .limit(10)
                .get();
            if (snapshot.empty) {
                return {
                    content: [{ type: "text", text: `No research found for topic: "${topic}"` }],
                };
            }
            const docs = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
            return {
                content: [{ type: "text", text: JSON.stringify(docs, null, 2) }],
            };
        }
        catch (error) {
            return {
                content: [{ type: "text", text: `Error: ${error.message}` }],
                isError: true,
            };
        }
    });
    server.tool("write_research", "Write or update a research cache entry. Creates a new document or updates an existing one by ID.", {
        id: z.string().optional().describe("Document ID (omit to auto-generate)"),
        topic: z.string().describe("Research topic"),
        content: z.string().describe("Research content/summary"),
        sources: z.array(z.string()).optional().describe("Source URLs"),
        tags: z.array(z.string()).optional().describe("Tags for categorisation"),
        quality: z.number().optional().describe("Quality score 0-1"),
    }, async ({ id, topic, content, sources, tags, quality }) => {
        try {
            const data = {
                topic,
                content,
                sources: sources || [],
                tags: tags || [],
                quality: quality ?? null,
                generatedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            let docRef;
            if (id) {
                docRef = db.collection(COLLECTION).doc(id);
                await docRef.set(data, { merge: true });
            }
            else {
                docRef = await db.collection(COLLECTION).add(data);
            }
            return {
                content: [
                    {
                        type: "text",
                        text: `Research cached successfully. Document ID: ${docRef.id}`,
                    },
                ],
            };
        }
        catch (error) {
            return {
                content: [{ type: "text", text: `Error: ${error.message}` }],
                isError: true,
            };
        }
    });
}
//# sourceMappingURL=research.js.map