/**
 * MCP Tool: get_generation_status
 * Scope: training:read
 *
 * Polls the status of a program generation job. Returns stage progress,
 * session count, and error details if any stage failed.
 *
 * PEL-231: Provides the polling mechanism that generate_weekly_plan needs
 * so AI coaching agents can detect success/failure and retry.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "../../firestore-client.js";
import { scrubDocument } from "../../scrubber.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { logToolCall, generateRequestId } from "../../logger.js";

export function registerGetGenerationStatus(server: McpServer): void {
  server.tool(
    "get_generation_status",
    "Check the status of a training plan generation job. Returns progress through pipeline stages and session count when complete.",
    {
      jobId: z
        .string()
        .min(1)
        .max(200)
        .describe("The generation job ID returned by generate_weekly_plan"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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
