/**
 * MCP Tool: generate_program
 * Scope: training:write
 *
 * Generate a complete training program and enrol it as the active program, via
 * the curated wayfinder `generateProgramServer` CF (Moonshot + the C-2 server
 * enrol). Produces a real `ai_generated` queue that the quality judge scores,
 * replacing the deprecated generate_weekly_plan (old pipeline -> orphan diary
 * entries, never scored). Covers short plans (durationWeeks 1-52).
 *
 * Generation triggers live Moonshot inference (Critical System #4) on a PUBLIC
 * surface, so this tool carries a STRICT generation rate-limit
 * (checkGenerationRateLimit) on top of the write limit (denial-of-wallet).
 *
 * CANARY-AT-BIRTH (Unified Uplift G3): in the local emulator CF_BASE_URL MUST be
 * overridden to the local functions emulator. If FIRESTORE_EMULATOR_HOST is set
 * but CF_BASE_URL still points at a non-local URL, the tool REFUSES rather than
 * write to prod (the single biggest footgun in this workstream).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GoogleAuth } from "google-auth-library";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { checkWriteRateLimit, checkGenerationRateLimit } from "../../middleware/rate-limiter.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";

const CF_BASE_URL =
  process.env.CF_BASE_URL || "https://australia-southeast1-wayfinder-ai-fitness.cloudfunctions.net";

let _auth: GoogleAuth | null = null;
function getAuth(): GoogleAuth {
  if (!_auth) _auth = new GoogleAuth();
  return _auth;
}
function isEmulator(): boolean {
  return !!process.env.FIRESTORE_EMULATOR_HOST;
}
function errResult(text: string) {
  return { content: [{ type: "text" as const, text: `Error: ${text}` }], isError: true };
}

export function registerGenerateProgram(server: McpServer): void {
  server.tool(
    "generate_program",
    "Generate a complete training program tailored to your goals and enrol it as your active program. Covers short plans (1-52 weeks); the program is automatically scored for quality.",
    {
      goal: z.string().min(1).max(500).describe("The training goal (e.g., 'build full-body strength', 'sub-45 10k')"),
      durationWeeks: z.number().int().min(1).max(52).optional().describe("Program length in weeks (1-52, default 4)"),
      sessionsPerWeek: z.number().int().min(1).max(14).optional().describe("Training sessions per week (default 3)"),
      notes: z.string().max(2000).optional().describe("Additional context, constraints, or preferences"),
      programType: z.string().max(80).optional().describe("Program type (e.g., 'strength', 'hybrid', 'running')"),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD").optional().describe("Start date (YYYY-MM-DD; defaults to today)"),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    async (params) => {
      const requestId = generateRequestId();
      const start = Date.now();
      try {
        const claims = getRequestAuth();
        if (!claims || !hasScope(claims.scope, "training:write")) {
          return errResult("training:write scope required");
        }
        // Strict generation limit first (denial-of-wallet), then the write limit.
        const genLimit = checkGenerationRateLimit(claims.sub);
        if (genLimit) return errResult(genLimit);
        const writeLimit = checkWriteRateLimit(claims.sub);
        if (writeLimit) return errResult(writeLimit);

        // CANARY-AT-BIRTH: never let an emulator run write to prod.
        if (isEmulator() && !/127\.0\.0\.1|localhost/.test(CF_BASE_URL)) {
          return errResult(
            "Refusing to generate: FIRESTORE_EMULATOR_HOST is set but CF_BASE_URL is not local. " +
              "Override CF_BASE_URL to the local functions emulator to avoid writing to production.",
          );
        }

        const targetUrl = `${CF_BASE_URL}/generateProgramServer`;
        const payload: Record<string, unknown> = {
          profileId: claims.profile_id,
          request: {
            goal: params.goal,
            durationWeeks: params.durationWeeks ?? 4,
            sessionsPerWeek: params.sessionsPerWeek ?? 3,
            ...(params.notes ? { notes: params.notes } : {}),
            ...(params.programType ? { programType: params.programType } : {}),
          },
          ...(params.startDate ? { startDate: params.startDate } : {}),
        };

        let data: Record<string, unknown>;
        if (isEmulator()) {
          const resp = await fetch(targetUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          data = (await resp.json()) as Record<string, unknown>;
        } else {
          const client = await getAuth().getIdTokenClient(targetUrl);
          const r = await client.request({
            url: targetUrl,
            method: "POST",
            data: payload,
            timeout: 570_000, // generation is multi-stage; allow up to ~9.5 min
          });
          data = r.data as Record<string, unknown>;
        }

        if (!data || data.ok !== true) {
          return errResult(`Generation failed: ${(data && (data.error as string)) || "unknown error"}`);
        }

        const status = data.generationStatus as string;
        const programName = (data.programName as string) ?? "your program";
        const sessionCount = (data.sessionCount as number) ?? 0;
        const message = status === "complete"
          ? `Your program "${programName}" is ready with ${sessionCount} sessions and is now your active program.`
          : `Your program "${programName}" has been started (${sessionCount} sessions so far); later weeks fill in as you progress.`;

        const result = scrubDocument({
          status,
          queueId: data.queueId,
          sessionCount,
          programName,
          message,
        });
        logToolCall({
          requestId,
          tool: "generate_program",
          userPseudonym: claims.sub,
          latencyMs: Date.now() - start,
          success: true,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        logToolCall({
          requestId,
          tool: "generate_program",
          latencyMs: Date.now() - start,
          success: false,
          error: (error as Error).message,
        });
        return errResult((error as Error).message);
      }
    },
  );
}
