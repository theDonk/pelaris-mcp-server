/**
 * MCP Prompt: session_debrief
 *
 * Post-workout analysis prompt. Designed to be used after a training session
 * to get coaching feedback on performance.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerSessionDebriefPrompt(server: McpServer): void {
  server.prompt(
    "session_debrief",
    "Post-workout debrief and analysis. Provide a session ID to get coaching feedback on what was completed, how it compares to targets, and what to focus on next.",
    {
      sessionId: z.string().describe("The diary session ID to debrief (e.g., session_strength_20260115_143022)"),
    },
    async ({ sessionId }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: buildSessionDebriefPrompt(sessionId),
          },
        },
      ],
    }),
  );
}

function buildSessionDebriefPrompt(sessionId: string): string {
  return `Debrief my workout session ${sessionId}.

Use the get_session_details tool to retrieve the session data, then analyze:

1. **Completion Rate** — What percentage of prescribed sets/reps were completed?
2. **Target vs Actual** — Where did I hit, exceed, or fall short of targets? Be specific with numbers.
3. **RPE Assessment** — How did the perceived effort align with the program's intent for this session?
4. **Key Observations** — Any standout performances, struggles, or patterns worth noting?
5. **Next Session Prep** — Based on this session, what should I focus on or adjust for the next one?

Be direct. Use specific data from the session. Coach me like you mean it.`;
}
