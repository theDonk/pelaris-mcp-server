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

export const CARDIO_CALIBRATION_RANGES: Readonly<Record<string, { min: number; max: number; unit: string; label: string }>> = {
  threshold_pace: { min: 135, max: 720, unit: "sec/km", label: "Threshold pace" },
  lthr_bpm: { min: 100, max: 220, unit: "bpm", label: "Lactate threshold heart rate (lthr_bpm)" },
  max_hr_bpm: { min: 120, max: 240, unit: "bpm", label: "Max heart rate (max_hr_bpm)" },
};

export const IMPLAUSIBLE_CALIBRATION_TEXT =
  "Error: implausible_calibration_value. Nothing was saved: cardio calibration benchmarks must fall within safe " +
  "physiological bounds (threshold_pace 135 to 720 sec/km, lthr_bpm 100 to 220 bpm, max_hr_bpm 120 to 240 bpm).";

const CALIBRATION_ALIASES: Readonly<Record<string, keyof typeof CARDIO_CALIBRATION_RANGES>> = {
  threshold_pace: "threshold_pace",
  lthr_bpm: "lthr_bpm",
  lthr: "lthr_bpm",
  lactate_threshold_hr: "lthr_bpm",
  lactate_threshold_heart_rate: "lthr_bpm",
  max_hr_bpm: "max_hr_bpm",
  max_hr: "max_hr_bpm",
  max_heart_rate: "max_hr_bpm",
};

/** Resolve a canonical cardio calibration key when benchmarkName refers to one. */
export function resolveCalibrationBenchmarkKey(
  benchmarkName: string,
): keyof typeof CARDIO_CALIBRATION_RANGES | null {
  const normalized = benchmarkName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return CALIBRATION_ALIASES[normalized] ?? null;
}

/** Return an actionable error string when a cardio calibration value is outside bounds, else null. */
export function calibrationRangeRefusal(benchmarkName: string, value: number): string | null {
  const key = resolveCalibrationBenchmarkKey(benchmarkName);
  if (!key) return null;
  const spec = CARDIO_CALIBRATION_RANGES[key];
  if (!Number.isFinite(value) || value < spec.min || value > spec.max) {
    return (
      `Error: implausible_calibration_value. ${spec.label} must be between ${spec.min} and ${spec.max} ` +
      `${spec.unit}. Nothing was saved.`
    );
  }
  return null;
}

export function registerRecordBenchmark(server: McpServer): void {
  server.registerTool(
    "record_benchmark",
    {
      title: "Record Benchmark",
      description: "Record a new personal best or benchmark result. Previous values are saved to history so you can track progress over time. " +
        "Name the benchmark as the athlete would (it is matched to Pelaris's own benchmark), give the value in the benchmark's unit, and say the unit. " +
        "Cardio calibration benchmarks: threshold_pace (135 to 720 sec/km), lthr_bpm (100 to 220 bpm), max_hr_bpm (120 to 240 bpm).",
      inputSchema: {
        benchmarkName: z
          .string()
          .min(1)
          .max(200)
          .describe("Name or id of the benchmark (e.g., 'Bench Press 1RM', '10km Run', 'squat_1rm', 'threshold_pace', 'lthr_bpm', 'max_hr_bpm')"),
        value: z
          .number()
          .describe("The benchmark value in the benchmark's unit (e.g., 100 for 100kg, 1350 for a 22:30 run in seconds, 270 for 4:30/km threshold_pace in sec/km, 171 for lthr_bpm)"),
        unit: z
          .string()
          .max(50)
          .optional()
          .describe("Unit of the value (e.g., 'kg', 'sec', 'sec/km', 'bpm', 'reps', 'watts'). A value in a different unit from the benchmark's is refused, never converted."),
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

        const calibrationError = calibrationRangeRefusal(params.benchmarkName, params.value);
        if (calibrationError) {
          logToolCall({
            requestId,
            tool: "record_benchmark",
            userPseudonym: claims.sub,
            latencyMs: Date.now() - start,
            success: false,
            error: "implausible_calibration_value",
          });
          return {
            content: [{ type: "text" as const, text: calibrationError }],
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
          const text =
            bridged.error === "benchmark_unit_mismatch"
              ? UNIT_MISMATCH_TEXT
              : bridged.error === "implausible_calibration_value"
                ? IMPLAUSIBLE_CALIBRATION_TEXT
                : `Error: ${bridged.error ?? "unknown error"}`;
          return {
            content: [{ type: "text" as const, text }],
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
