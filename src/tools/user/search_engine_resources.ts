/**
 * MCP Tool: search_engine_resources
 * Scope: coach:read
 *
 * Searches the engine_resources collection for curated coaching resources
 * matching a query by title, summary, category, or tags.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "../../firestore-client.js";
import { scrubDocument } from "../../scrubber.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { logToolCall, generateRequestId } from "../../logger.js";

export function registerSearchEngineResources(server: McpServer): void {
  server.tool(
    "search_training_resources",
    "Search the curated library of coaching articles, videos, and guides. Find resources by topic, sport, or training goal.",
    {
      query: z.string().describe("Search query — topic, sport, goal, or keyword (e.g., 'swimming technique', 'recovery', 'strength periodization')"),
      category: z.string().optional().describe("Filter by category: fuel, recover, learn, prepare"),
      sport: z.string().optional().describe("Filter by sport: strength, running, swimming, cycling, triathlon"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ query, category, sport }) => {
      const requestId = generateRequestId();
      const start = Date.now();

      try {
        const claims = getRequestAuth();
        if (!claims || !hasScope(claims.scope, "coach:read")) {
          return {
            content: [{ type: "text" as const, text: "Error: coach:read scope required" }],
            isError: true,
          };
        }

        // Build query — Firestore doesn't support full-text search,
        // so we fetch active resources and filter client-side
        let firestoreQuery: FirebaseFirestore.Query = db.collection("engine_resources")
          .where("active", "==", true);

        if (category) {
          firestoreQuery = firestoreQuery.where("category", "==", category);
        }

        const snapshot = await firestoreQuery.limit(50).get();

        if (snapshot.empty) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ resources: [], message: "No resources found" }) }],
          };
        }

        // Client-side search scoring
        const queryTerms = query.toLowerCase().split(/\s+/);
        const scored = snapshot.docs.map((doc) => {
          const d = doc.data();
          let score = 0;
          const searchable = [
            d.title || "",
            d.summary || "",
            d.category || "",
            ...(d.sports || []),
            ...(d.contexts || []),
            ...(d.goals || []),
            ...(d.experience || []),
          ].join(" ").toLowerCase();

          for (const term of queryTerms) {
            if (searchable.includes(term)) score++;
          }

          // Sport filter boost
          if (sport && (d.sports || []).some((s: string) => s.toLowerCase() === sport.toLowerCase())) {
            score += 2;
          }

          return { doc, score };
        });

        // Sort by score descending, take top 5
        const topResults = scored
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);

        if (topResults.length === 0) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ resources: [], message: `No resources matching "${query}"` }) }],
          };
        }

        const resources = topResults.map((r) => {
          const d = r.doc.data();
          return {
            resourceId: r.doc.id,
            title: d.title,
            summary: d.summary,
            url: d.url,
            category: d.category,
            contentType: d.content_type || d.contentType,
            sports: d.sports || [],
            readTimeMinutes: d.read_time_minutes || d.readTimeMinutes,
            evidenceLevel: d.evidence_level || d.evidenceLevel,
          };
        });

        const result = scrubDocument({ resources, query } as Record<string, unknown>);

        logToolCall({
          requestId,
          tool: "search_engine_resources",
          userPseudonym: claims.sub,
          latencyMs: Date.now() - start,
          success: true,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        logToolCall({
          requestId,
          tool: "search_engine_resources",
          latencyMs: Date.now() - start,
          success: false,
          error: (error as Error).message,
        });
        return {
          content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
