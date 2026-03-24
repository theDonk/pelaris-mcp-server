/**
 * MCP Prompt: benchmark_check_in
 *
 * Progress review prompt focused on benchmark metrics.
 * Helps users understand their performance trajectory.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerBenchmarkCheckInPrompt(server: McpServer): void {
  server.prompt(
    "benchmark_check_in",
    "Review benchmark progress and performance trends. Analyzes current values, historical changes, and alignment with goals.",
    {
      benchmarkId: z.string().optional().describe("Specific benchmark to focus on (e.g., bench_press_1rm, squat_1rm). Omit for full review."),
    },
    async ({ benchmarkId }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: buildBenchmarkCheckInPrompt(benchmarkId),
          },
        },
      ],
    }),
  );
}

function buildBenchmarkCheckInPrompt(benchmarkId?: string): string {
  const focus = benchmarkId
    ? `Focus specifically on my ${benchmarkId} benchmark.`
    : "Review all my benchmarks.";

  return `Check in on my benchmark progress. ${focus}

Use the get_benchmarks tool to retrieve my data, then provide:

1. **Current Status** — Where do my key benchmarks stand right now?
2. **Trend Analysis** — Which benchmarks are improving, plateauing, or declining?
3. **Rate of Progress** — Is the improvement rate sustainable and aligned with my training phase?
4. **Goal Connection** — How do these benchmarks connect to my stated goals?
5. **Action Items** — Specific, actionable recommendations to drive the most important benchmarks forward.

Reference actual values and percentages. No generic advice — coach me based on MY numbers.`;
}
