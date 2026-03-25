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
    "View your performance benchmarks — current values, trends, and progress over time.",
    {},
    { readOnlyHint: true },
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

        // Sanity ranges for body measurement benchmarks (in cm/kg)
        const BODY_MEASUREMENT_RANGES: Record<string, { min: number; max: number }> = {
          shoulder_circumference: { min: 70, max: 170 },
          shoulders: { min: 70, max: 170 },
          waist: { min: 50, max: 150 },
          waist_circumference: { min: 50, max: 150 },
          hip: { min: 60, max: 160 },
          hip_circumference: { min: 60, max: 160 },
          hips: { min: 60, max: 160 },
          weight: { min: 30, max: 250 },
          body_weight: { min: 30, max: 250 },
        };

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

          // Data quality sanity check for body measurements
          let dataQuality: "valid" | "suspect" = "valid";
          const idLower = doc.id.toLowerCase();
          const range = BODY_MEASUREMENT_RANGES[idLower];
          if (range && currentValue != null) {
            if (currentValue < range.min || currentValue > range.max) {
              dataQuality = "suspect";
            }
          }

          return {
            benchmarkId: doc.id,
            currentValue,
            previousValue,
            trend,
            dataQuality,
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
