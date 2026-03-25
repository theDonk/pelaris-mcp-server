/**
 * MCP Tool: manage_program
 * Scope: training:write
 *
 * Program lifecycle operations: archive, list history, and get current.
 * Reads/writes to profiles/{profileId}/queues/.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { profileSubcollection } from "../../firestore-client.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { checkWriteRateLimit } from "../../middleware/rate-limiter.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import type { QueryDocumentSnapshot } from "firebase-admin/firestore";

const VALID_ACTIONS = ["archive", "list_history", "get_current"] as const;

function summarizeProgram(doc: QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data();
  const sessions = (d.sessions || []) as Array<Record<string, unknown>>;
  const completed = sessions.filter((s) => s.is_completed).length;
  const weeks = [...new Set(sessions.map((s) => s.week_number as number))].sort((a, b) => a - b);

  return {
    queueId: doc.id,
    title: d.title || null,
    methodologyId: d.methodology_id || null,
    sourceProgramId: d.source_program_id || null,
    type: d.type || null,
    totalSessions: sessions.length,
    completedSessions: completed,
    completionPercent: sessions.length > 0 ? Math.round((completed / sessions.length) * 100) : 0,
    totalWeeks: weeks.length,
    generationStatus: d.generation_status || null,
    status: d.status || "active",
    dateCreated: d.date_created?.toDate?.()?.toISOString?.() || null,
    archivedAt: d.archived_at?.toDate?.()?.toISOString?.() || d.archived_at || null,
  };
}

export function registerManageProgram(server: McpServer): void {
  server.tool(
    "manage_program",
    "View, archive, or review your training programs. See active programs, program history, or archive a completed program.",
    {
      action: z
        .enum(VALID_ACTIONS)
        .describe("The action to perform: archive, list_history, or get_current"),
      programId: z
        .string()
        .max(200)
        .optional()
        .describe("Program/queue ID to archive (defaults to the most recent active program)"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async (params) => {
      const requestId = generateRequestId();
      const start = Date.now();

      try {
        // Auth & scope check
        const claims = getRequestAuth();
        if (!claims || !hasScope(claims.scope, "training:write")) {
          return {
            content: [{ type: "text" as const, text: "Error: training:write scope required" }],
            isError: true,
          };
        }

        const profileId = claims.profile_id;
        const queuesCol = profileSubcollection(profileId, "queues");

        // ── GET_CURRENT ───────────────────────────────────────────
        if (params.action === "get_current") {
          const queuesSnap = await queuesCol
            .orderBy("date_created", "desc")
            .limit(5)
            .get();

          if (queuesSnap.empty) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ programs: [], message: "No active programs found" }) }],
            };
          }

          // Filter to non-archived programs
          const activePrograms = queuesSnap.docs
            .filter((doc) => {
              const d = doc.data();
              return d.status !== "archived";
            })
            .map(summarizeProgram);

          const result = scrubDocument({ programs: activePrograms } as Record<string, unknown>);

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
        }

        // ── LIST_HISTORY ──────────────────────────────────────────
        if (params.action === "list_history") {
          const queuesSnap = await queuesCol
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
            tool: "manage_program",
            userPseudonym: claims.sub,
            latencyMs: Date.now() - start,
            success: true,
          });

          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        // ── ARCHIVE ───────────────────────────────────────────────
        if (params.action === "archive") {
          // Write rate limit
          const rateLimitError = checkWriteRateLimit(claims.sub);
          if (rateLimitError) {
            return {
              content: [{ type: "text" as const, text: `Error: ${rateLimitError}` }],
              isError: true,
            };
          }

          let targetDocId = params.programId;

          // If no programId specified, find the most recent active program
          if (!targetDocId) {
            const activeSnap = await queuesCol
              .orderBy("date_created", "desc")
              .limit(5)
              .get();

            const activeDoc = activeSnap.docs.find((doc) => {
              const d = doc.data();
              return d.status !== "archived";
            });

            if (!activeDoc) {
              return {
                content: [{ type: "text" as const, text: "Error: No active program found to archive" }],
                isError: true,
              };
            }
            targetDocId = activeDoc.id;
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
        }

        return {
          content: [{ type: "text" as const, text: `Error: Unknown action "${params.action}"` }],
          isError: true,
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
