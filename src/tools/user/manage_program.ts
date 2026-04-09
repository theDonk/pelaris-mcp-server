/**
 * MCP Tool: manage_program (archive only)
 * Scope: training:write
 *
 * PEL-221: Read-only actions (get_current, list_history) moved to get_program_status.
 * This tool now only handles archive — destructiveHint:true is appropriate.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getActiveQueueDocuments, profileSubcollection } from "../../firestore-client.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { checkWriteRateLimit } from "../../middleware/rate-limiter.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";

export function registerManageProgram(server: McpServer): void {
  server.tool(
    "manage_program",
    "Archive a training program. Use get_program_status to view programs first.",
    {
      action: z
        .literal("archive")
        .describe("Archive a program"),
      programId: z
        .string()
        .max(200)
        .optional()
        .describe("Program/queue ID to archive (defaults to the most recent active program)"),
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
    async (params) => {
      const requestId = generateRequestId();
      const start = Date.now();

      try {
        const claims = getRequestAuth();
        if (!claims || !hasScope(claims.scope, "training:write")) {
          return {
            content: [{ type: "text" as const, text: "Error: training:write scope required" }],
            isError: true,
          };
        }

        const profileId = claims.profile_id;
        const queuesCol = profileSubcollection(profileId, "queues");

        // Write rate limit
        const rateLimitError = checkWriteRateLimit(claims.sub);
        if (rateLimitError) {
          return {
            content: [{ type: "text" as const, text: `Error: ${rateLimitError}` }],
            isError: true,
          };
        }

        let targetDocId = params.programId;

        // If no programId specified, find the most recent active program via profile
        if (!targetDocId) {
          const { queueDocs } = await getActiveQueueDocuments(profileId);
          if (queueDocs.length === 0) {
            return {
              content: [{ type: "text" as const, text: "Error: No active program found to archive" }],
              isError: true,
            };
          }
          targetDocId = queueDocs[0].id;
        }

        const docRef = queuesCol.doc(targetDocId);
        const existingDoc = await docRef.get();

        if (!existingDoc.exists) {
          return {
            content: [{ type: "text" as const, text: `Error: Program "${targetDocId}" not found` }],
            isError: true,
          };
        }

        const existingData = existingDoc.data()!;
        if (existingData.status === "archived") {
          return {
            content: [{ type: "text" as const, text: `Error: Program "${targetDocId}" is already archived` }],
            isError: true,
          };
        }

        await docRef.update({
          status: "archived",
          archived_at: new Date().toISOString(),
        });

        const sessions = (existingData.sessions || []) as Array<Record<string, unknown>>;
        const completed = sessions.filter((s) => s.is_completed).length;

        const result = scrubDocument({
          queueId: targetDocId,
          action: "archived",
          title: existingData.title,
          completedSessions: completed,
          totalSessions: sessions.length,
          completionPercent: sessions.length > 0 ? Math.round((completed / sessions.length) * 100) : 0,
          message: `Program "${existingData.title}" archived (${completed}/${sessions.length} sessions completed)`,
        });

        logToolCall({
          requestId,
          tool: "manage_program",
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
          tool: "manage_program",
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
