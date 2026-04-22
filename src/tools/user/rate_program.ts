/**
 * MCP Tool: rate_program
 * Scope: coach:write
 *
 * Calls the public pelaris.io "Rate My Program" Cloud Function to score
 * a user-pasted training program against the 8-criterion quality rubric.
 * Reuses the same backend as pelaris.io/rate-my-program — no duplicate
 * logic, one rubric, one prompt version.
 *
 * Transport: HTTPS POST to the deployed `ratePublicProgram` function,
 * authenticated via the shared `INTERNAL_API_TOKEN` header which lets the
 * MCP caller bypass Turnstile + IP rate-limit. MCP has its own OAuth
 * scope gating + per-tool rate shaping.
 *
 * Returns: overall grade (A-F), one-sentence verdict, per-criterion
 * pass/fail + swap action, plus a shareable URL at pelaris.io/rate/{id}.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { logToolCall, generateRequestId } from "../../logger.js";

// The deployed CF URL. Firebase v2 functions follow the pattern
// https://<function-name>-<hash>-<region-short>.a.run.app but also respond
// at the legacy cloudfunctions.net URL, which is easier to reason about.
const RATE_PROGRAM_CF_URL =
  process.env.RATE_PUBLIC_PROGRAM_URL ||
  "https://australia-southeast1-wayfinder-ai-fitness.cloudfunctions.net/ratePublicProgram";

// Shared secret with the CF. Set in the MCP server's runtime env; the
// same value must be stored in Firebase Functions `INTERNAL_API_TOKEN`
// secret so the CF accepts this call without Turnstile.
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "";

interface RatePublicProgramResult {
  shortId: string;
  verdict: string;
  grade: "A" | "B" | "C" | "D" | "F";
  passCount: number;
  passRate: number;
  failedCriteria: string[];
  criteria: Record<string, { pass: boolean; reason: string; swap: string }>;
}

export function registerRateProgram(server: McpServer): void {
  server.tool(
    "rate_program",
    "Grade any training program (yours, a friend's, one you found online) against the 8-criterion quality rubric. Paste the program as plain text. Returns an A-F grade, a one-line verdict, per-criterion pass/fail with specific swaps, and a shareable URL at pelaris.io/rate/{id}.",
    {
      programText: z.string()
        .min(40, "programText must be at least 40 characters")
        .max(12000, "programText must be under 12,000 characters")
        .describe("The training program as plain text. Bullet list, table, or session-by-session all OK. Example: 'Mon: Squat 5x5 at 80kg, Bench 5x5...'"),
      goal: z.string().optional()
        .describe("Optional — the user's goal (strength, hypertrophy, marathon, fat loss, etc.)"),
      experienceLevel: z.enum(["beginner", "intermediate", "advanced"]).optional()
        .describe("Optional — experience level. Tone of the verdict adapts. Defaults to intermediate."),
      hoursPerWeek: z.number().optional()
        .describe("Optional — available training hours per week"),
      injuries: z.string().optional()
        .describe("Optional — any injuries or restrictions the program should respect"),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ programText, goal, experienceLevel, hoursPerWeek, injuries }) => {
      const requestId = generateRequestId();
      const start = Date.now();

      try {
        const claims = getRequestAuth();
        if (!claims || !hasScope(claims.scope, "coach:write")) {
          return {
            content: [{ type: "text" as const, text: "Error: coach:write scope required (rate_program creates a persisted rating doc)" }],
            isError: true,
          };
        }

        if (!INTERNAL_API_TOKEN) {
          return {
            content: [{ type: "text" as const, text: "Error: MCP server not configured with INTERNAL_API_TOKEN env var. Ask the admin to set it to the same value as the Firebase Functions INTERNAL_API_TOKEN secret." }],
            isError: true,
          };
        }

        const cfRes = await fetch(RATE_PROGRAM_CF_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-internal-auth": INTERNAL_API_TOKEN,
          },
          body: JSON.stringify({
            programText,
            context: {
              goal,
              experienceLevel,
              hoursPerWeek,
              injuries,
              ref: `mcp:${claims.sub}`, // MCP user pseudonym for attribution analytics
            },
          }),
        });

        if (!cfRes.ok) {
          const errText = await cfRes.text();
          throw new Error(`CF returned ${cfRes.status}: ${errText.slice(0, 200)}`);
        }

        const result = (await cfRes.json()) as RatePublicProgramResult;

        // Format the output as a readable report for the MCP caller.
        const shareUrl = `https://pelaris.io/rate?id=${result.shortId}`;
        const passes = Object.entries(result.criteria)
          .filter(([, v]) => v.pass)
          .map(([name]) => `  ✓ ${name}`);
        const fails = Object.entries(result.criteria)
          .filter(([, v]) => !v.pass)
          .map(([name, v]) => `  ✗ ${name}: ${v.reason}\n    Fix → ${v.swap}`);

        const summary = [
          `# Program Rating: ${result.grade}  (${result.passCount}/8 passed)`,
          ``,
          `> ${result.verdict}`,
          ``,
          `## What works`,
          passes.length > 0 ? passes.join("\n") : "  (nothing cleanly — see below)",
          ``,
          `## What to fix`,
          fails.length > 0 ? fails.join("\n\n") : "  (all criteria passed)",
          ``,
          `## Shareable link`,
          shareUrl,
        ].join("\n");

        logToolCall({
          requestId,
          tool: "rate_program",
          userPseudonym: claims.sub,
          latencyMs: Date.now() - start,
          success: true,
        });

        return {
          content: [{ type: "text" as const, text: summary }],
        };
      } catch (error) {
        logToolCall({
          requestId,
          tool: "rate_program",
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
