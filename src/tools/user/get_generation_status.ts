/**
 * MCP Tool: get_generation_status
 * Scope: training:read
 *
 * Polls the status of a program generation job. Returns stage progress,
 * session count, and error details if any stage failed.
 *
 * PEL-231: originally the polling mechanism generate_weekly_plan's jobId
 * fed, so AI coaching agents could detect success/failure and retry.
 * generate_weekly_plan is RETIRED (GL-I16, Spring Tide 1.2.0, 16/09/2026);
 * its replacement, generate_program, runs synchronously and returns no
 * jobId (see generate_program.ts's result shape) — NOT reworded to point at
 * it below, since that would claim a jobId generate_program never returns.
 * No currently-registered tool hands back a jobId this reads; flagged for
 * Fable/Brad as a possible follow-up (either retire this tool too, or wire
 * a jobId-returning path back in) rather than guessed at here.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "../../firestore-client.js";
import { scrubDocument } from "../../scrubber.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { logToolCall, generateRequestId } from "../../logger.js";

export function registerGetGenerationStatus(server: McpServer): void {
  server.registerTool(
    "get_generation_status",
    {
      title: "Get Generation Status",
      description: "Check the status of a training plan generation job. Returns progress through pipeline stages and session count when complete.",
      inputSchema: {
        jobId: z
          .string()
          .min(1)
          .max(200)
          .describe("The generation job ID to check the status of"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, title: "Get Generation Status" },
    },
    async (params) => {
      const requestId = generateRequestId();
      const start = Date.now();

      try {
        const claims = getRequestAuth();
        if (!claims || !hasScope(claims.scope, "training:read")) {
          return {
            content: [{ type: "text" as const, text: "Error: training:read scope required" }],
            isError: true,
          };
        }

        const profileId = claims.profile_id;
        const jobRef = db.collection("profiles").doc(profileId)
          .collection("generation_jobs").doc(params.jobId);
        const jobSnap = await jobRef.get();

        if (!jobSnap.exists) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "Job not found", jobId: params.jobId }) }],
            isError: true,
          };
        }

        const data = jobSnap.data()!;

        // Count sessions across all week snapshots
        let sessionCount = 0;
        const weekSnapshots = data.weekSnapshots as Record<string, { sessions?: unknown[] }> | undefined;
        if (weekSnapshots) {
          for (const [, snap] of Object.entries(weekSnapshots)) {
            sessionCount += snap.sessions?.length || 0;
          }
        }

        const result = scrubDocument({
          jobId: params.jobId,
          status: data.status || "unknown",
          stage: data.stage || null,
          programName: data.programName || null,
          totalWeeks: data.totalWeeks || null,
          currentWeek: data.currentWeek || null,
          sessionsGenerated: sessionCount,
          sessionsWritten: data.sessionsWritten || 0,
          error: data.errorMessage || null,
          createdAt: data.createdAt?.toDate?.()?.toISOString?.() || null,
          completedAt: data.completedAt?.toDate?.()?.toISOString?.() || null,
        });

        logToolCall({
          requestId,
          tool: "get_generation_status",
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
          tool: "get_generation_status",
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
