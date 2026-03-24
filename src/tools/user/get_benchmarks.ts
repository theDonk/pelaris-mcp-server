/**
 * MCP Tool: get_benchmarks
 * Scope: health:read
 *
 * Returns the user's performance benchmarks with current values, history, and trends.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { profileSubcollection } from "../../firestore-client.js";
import { scrubDocument } from "../../scrubber.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { logToolCall, generateRequestId } from "../../logger.js";

export function registerGetBenchmarks(server: McpServer): void {
  server.tool(
    "get_benchmarks",
    "Get the user's performance benchmarks. Returns benchmark name, current value, previous value, trend direction, and improvement status.",
    {},
    async () => {
      const requestId = generateRequestId();
      const start = Date.now();

      try {
        const claims = getRequestAuth();
        if (!claims || !hasScope(claims.scope, "health:read")) {
          return {
            content: [{ type: "text" as const, text: "Error: health:read scope required" }],
            isError: true,
          };
        }

        const profileId = claims.profile_id;
        const benchmarksSnap = await profileSubcollection(profileId, "benchmarks").get();

        if (benchmarksSnap.empty) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ benchmarks: [], message: "No benchmarks recorded yet" }) }],
          };
        }

        const benchmarks = benchmarksSnap.docs.map((doc) => {
          const d = doc.data();
          const history = (d.history || []) as Array<Record<string, unknown>>;
          const currentValue = d.current_max;
          const previousValue = history.length >= 2
            ? (history[history.length - 2]?.value as number) ?? null
            : null;

          // Determine trend
          let trend: "up" | "down" | "stable" | "new" = "new";
          if (previousValue !== null && currentValue !== null) {
            if (currentValue > previousValue) trend = "up";
            else if (currentValue < previousValue) trend = "down";
            else trend = "stable";
          }

          return {
            benchmarkId: doc.id,
            currentValue,
            previousValue,
            trend,
            lastUpdated: d.last_updated?.toDate?.()?.toISOString?.() || null,
            historyCount: history.length,
          };
        });

        const result = scrubDocument({ benchmarks } as Record<string, unknown>);

        logToolCall({
          requestId,
          tool: "get_benchmarks",
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
          tool: "get_benchmarks",
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
