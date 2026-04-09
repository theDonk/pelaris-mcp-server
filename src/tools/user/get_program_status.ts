/**
 * MCP Tool: get_program_status
 * Scope: training:read
 *
 * PEL-221: Split from manage_program. Read-only program queries that don't need
 * destructive approval. Shows current active programs or full program history.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getActiveQueueDocuments, profileSubcollection } from "../../firestore-client.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import { summarizeProgram } from "../shared/program-utils.js";

const VALID_ACTIONS = ["get_current", "list_history"] as const;

export function registerGetProgramStatus(server: McpServer): void {
  server.tool(
    "get_program_status",
    "View your current active training programs or browse your full program history.",
    {
      action: z
        .enum(VALID_ACTIONS)
        .describe("get_current: show active programs. list_history: show all programs including archived."),
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

        if (params.action === "get_current") {
          // PEL-220: Use profile.active_queues as source of truth
          const { queueDocs } = await getActiveQueueDocuments(profileId);

          if (queueDocs.length === 0) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ programs: [], message: "No active programs found" }) }],
            };
          }

          const programs = queueDocs.map(summarizeProgram);
          const result = scrubDocument({ programs } as Record<string, unknown>);

          logToolCall({
            requestId,
            tool: "get_program_status",
            userPseudonym: claims.sub,
            latencyMs: Date.now() - start,
            success: true,
          });

          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        // list_history
        const queuesSnap = await profileSubcollection(profileId, "queues")
          .orderBy("date_created", "desc")
          .limit(20)
          .get();

        if (queuesSnap.empty) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ programs: [], message: "No programs found" }) }],
          };
        }

        const programs = queuesSnap.docs.map(summarizeProgram);
        const result = scrubDocument({ programs } as Record<string, unknown>);

        logToolCall({
          requestId,
          tool: "get_program_status",
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
          tool: "get_program_status",
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
