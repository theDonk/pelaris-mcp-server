/**
 * MCP Prompt: weekly_plan_review
 *
 * Structured prompt template for reviewing a user's weekly training plan.
 * Designed for AI platforms to use with the user's training data.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerWeeklyPlanReviewPrompt(server: McpServer): void {
  server.prompt(
    "weekly_plan_review",
    "Generate a weekly training plan review. Analyzes completed sessions, missed sessions, RPE trends, and alignment with program goals. Call get_training_context first to populate the data.",
    {
      weekNumber: z.string().optional().describe("The week number to review (defaults to current week)"),
      focusArea: z.string().optional().describe("Specific area to focus on: consistency, intensity, recovery, technique"),
    },
    async ({ weekNumber, focusArea }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: buildWeeklyReviewPrompt(weekNumber, focusArea),
          },
        },
      ],
    }),
  );
}

function buildWeeklyReviewPrompt(weekNumber?: string, focusArea?: string): string {
  const weekRef = weekNumber ? `week ${weekNumber}` : "the current week";
  const focusClause = focusArea
    ? `Pay special attention to ${focusArea}.`
    : "";

  return `Review my training for ${weekRef}. ${focusClause}

Please use the get_training_context and get_active_program tools to get my data, then provide:

1. **Completion Summary** — How many sessions were completed vs planned? Was the target hit?
2. **Intensity Check** — What was the average RPE? Is it trending up, down, or stable vs last week?
3. **Program Alignment** — Are the completed sessions tracking with the program's current phase focus?
4. **Recovery Signal** — Any signs of accumulated fatigue or insufficient recovery?
5. **Next Week Outlook** — What should I prioritize next week based on this week's data?

Keep the review direct and data-specific. Reference actual numbers, session names, and benchmark values where available.`;
}
