/**
 * MCP Tool: record_benchmark
 * Scope: health:write
 *
 * Records or updates a user benchmark value. If the benchmark already exists,
 * pushes the previous value to history and updates currentValue.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { profileSubcollection } from "../../firestore-client.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { checkWriteRateLimit } from "../../middleware/rate-limiter.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import { FieldValue } from "firebase-admin/firestore";

/**
 * Normalize a benchmark name to a Firestore-safe document ID.
 * e.g., "Bench Press 1RM" → "bench_press_1rm"
 */
function normalizeBenchmarkId(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export function registerRecordBenchmark(server: McpServer): void {
  server.tool(
    "record_benchmark",
    "Record a new personal best or benchmark result. Previous values are saved to history so you can track progress over time.",
    {
      benchmarkName: z
        .string()
        .min(1)
        .max(200)
        .describe("Name of the benchmark (e.g., 'bench_press_1rm', 'squat_1rm', '5km_run')"),
      value: z
        .number()
        .describe("The benchmark value (e.g., 100 for 100kg, 1350 for 22:30 in seconds)"),
      unit: z
        .string()
        .max(50)
        .optional()
        .describe("Unit of measurement (e.g., 'kg', 'sec', 'reps', 'watts'). Defaults to context-appropriate unit."),
      notes: z
        .string()
        .max(500)
        .optional()
        .describe("Optional notes about this benchmark recording"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async (params) => {
      const requestId = generateRequestId();
      const start = Date.now();

      try {
        // Auth & scope check
        const claims = getRequestAuth();
        if (!claims || !hasScope(claims.scope, "health:write")) {
          return {
            content: [{ type: "text" as const, text: "Error: health:write scope required" }],
            isError: true,
          };
        }

        // Write rate limit
        const rateLimitError = checkWriteRateLimit(claims.sub);
        if (rateLimitError) {
          return {
            content: [{ type: "text" as const, text: `Error: ${rateLimitError}` }],
            isError: true,
          };
        }

        const profileId = claims.profile_id;
        const benchmarkId = normalizeBenchmarkId(params.benchmarkName);
        const benchmarksCol = profileSubcollection(profileId, "benchmarks");
        const docRef = benchmarksCol.doc(benchmarkId);
        const existingDoc = await docRef.get();

        const timestamp = new Date().toISOString();
        const historyEntry = {
          date: new Date(),
          value: params.value,
          extras: {
            source: "mcp" as const,
            ...(params.notes ? { notes: params.notes } : {}),
            ...(params.unit ? { unit: params.unit } : {}),
          },
        };

        let previousValue: number | null = null;
        let improvementDirection: "higher" | "lower" | "context" = "higher";

        if (existingDoc.exists) {
          const data = existingDoc.data()!;
          previousValue = data.current_max ?? null;

          // Determine improvement direction from existing data if available
          if (data.improvement_direction) {
            improvementDirection = data.improvement_direction;
          }

          // Update: push new entry to history, update current_max
          await docRef.update({
            current_max: params.value,
            last_updated: FieldValue.serverTimestamp(),
            history: FieldValue.arrayUnion(historyEntry),
          });
        } else {
          // Create new benchmark document
          await docRef.set({
            benchmark_id: benchmarkId,
            current_max: params.value,
            last_updated: FieldValue.serverTimestamp(),
            history: [historyEntry],
          });
        }

        // Determine if this is an improvement
        let changeDescription: string | null = null;
        if (previousValue !== null) {
          const delta = params.value - previousValue;
          if (improvementDirection === "higher") {
            changeDescription = delta > 0 ? "improved" : delta < 0 ? "declined" : "unchanged";
          } else if (improvementDirection === "lower") {
            changeDescription = delta < 0 ? "improved" : delta > 0 ? "declined" : "unchanged";
          } else {
            changeDescription = delta > 0 ? "increased" : delta < 0 ? "decreased" : "unchanged";
          }
        }

        const result = scrubDocument({
          benchmarkId,
          benchmarkName: params.benchmarkName,
          newValue: params.value,
          previousValue,
          unit: params.unit || null,
          improvementDirection,
          change: changeDescription,
          status: existingDoc.exists ? "updated" : "created",
          message: existingDoc.exists
            ? `Benchmark "${benchmarkId}" updated: ${previousValue} → ${params.value}${params.unit ? ` ${params.unit}` : ""}`
            : `Benchmark "${benchmarkId}" created with value ${params.value}${params.unit ? ` ${params.unit}` : ""}`,
        });

        logToolCall({
          requestId,
          tool: "record_benchmark",
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
          tool: "record_benchmark",
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
