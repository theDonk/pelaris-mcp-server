/**
 * MCP Tool: record_benchmark
 * Scope: health:write
 *
 * Records a benchmark result. The write is the core's `update_athlete`
 * (type "benchmark") over the coreToolsBridge, the same implementation the
 * in-app coach uses; this tool does not write Firestore itself. Through the
 * core, a write:
 * - lands on the canonical benchmark id: a name or id is resolved to the
 *   catalogue's own id first, so the same benchmark is never split across docs;
 * - passes the shared unit check: a value whose unit does not fit the
 *   benchmark (a lift into a time, minutes into seconds) is refused, never
 *   converted, and nothing is saved;
 * - carries the tracking flag and history provenance the summaries read.
 *
 * Ownership: only the token's own `claims.profile_id` is sent, and the tool pins
 * `type: "benchmark"` itself. A bridge failure returns the core's closed error
 * code, and there is no direct-write fallback.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { checkWriteRateLimit } from "../../middleware/rate-limiter.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import { callCoreBridge } from "../shared/bridge_client.js";

/** What the caller can do about the core's unit refusal (the code alone is opaque). */
export const UNIT_MISMATCH_TEXT =
  "Error: benchmark_unit_mismatch. Nothing was saved: the value's unit does not match the unit this benchmark " +
  "is recorded in (a run time is in seconds, a lift in kg). Check the unit with get_benchmarks, convert the " +
  "number to it, and record it again with that unit, or record a different benchmark if this is a different test.";

export function registerRecordBenchmark(server: McpServer): void {
  server.registerTool(
    "record_benchmark",
    {
      title: "Record Benchmark",
      description: "Record a new personal best or benchmark result. Previous values are saved to history so you can track progress over time. " +
        "Name the benchmark as the athlete would (it is matched to Pelaris's own benchmark), give the value in the benchmark's unit, and say the unit.",
      inputSchema: {
        benchmarkName: z
          .string()
          .min(1)
          .max(200)
          .describe("Name or id of the benchmark (e.g., 'Bench Press 1RM', '10km Run', 'squat_1rm')"),
        value: z
          .number()
          .describe("The benchmark value in the benchmark's unit (e.g., 100 for 100kg, 1350 for a 22:30 run in seconds)"),
        unit: z
          .string()
          .max(50)
          .optional()
          .describe("Unit of the value (e.g., 'kg', 'sec', 'reps', 'watts'). A value in a different unit from the benchmark's is refused, never converted."),
        notes: z
          .string()
          .max(500)
          .optional()
          .describe("Optional notes about this benchmark recording"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false, title: "Record Benchmark" },
    },
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

        // The core's update_athlete, branch "benchmark", for the token's own profile only.
        const bridged = await callCoreBridge("update_athlete", claims.profile_id, {
          type: "benchmark",
          benchmarkName: params.benchmarkName,
          value: params.value,
          ...(params.unit ? { unit: params.unit } : {}),
          ...(params.notes ? { notes: params.notes } : {}),
        });

        if (!bridged.ok || bridged.result == null) {
          logToolCall({
            requestId,
            tool: "record_benchmark",
            latencyMs: Date.now() - start,
            success: false,
            error: bridged.error ?? "bridge_failed",
          });
          return {
            content: [{
              type: "text" as const,
              text: bridged.error === "benchmark_unit_mismatch" ? UNIT_MISMATCH_TEXT : `Error: ${bridged.error ?? "unknown error"}`,
            }],
            isError: true,
          };
        }

        const core = bridged.result as Record<string, unknown>;
        const previousValue = typeof core.previousValue === "number" ? core.previousValue : null;
        // The same response fields the direct write returned, from the core's outcome.
        const result = scrubDocument({
          benchmarkId: core.benchmarkId,
          benchmarkName: params.benchmarkName,
          newValue: core.newValue ?? params.value,
          previousValue,
          unit: params.unit || null,
          improvementDirection: core.improvementDirection ?? null,
          change: core.change ?? null,
          status: previousValue === null ? "created" : "updated",
          message: core.message,
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
