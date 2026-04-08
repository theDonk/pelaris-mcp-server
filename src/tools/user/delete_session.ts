/**
 * MCP Tool: delete_session / delete_sessions
 * Scope: training:write
 *
 * Deletes planned diary sessions by ID. Completed and Strava-imported
 * sessions cannot be deleted.
 *
 * PEL-237
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { profileSubcollection } from "../../firestore-client.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { checkWriteRateLimit } from "../../middleware/rate-limiter.js";
import { logToolCall, generateRequestId } from "../../logger.js";

/** Guard: only planned sessions can be deleted. */
function canDelete(data: Record<string, unknown>): { allowed: boolean; reason?: string } {
  if (data.status === "completed" || data.is_completed === true) {
    return { allowed: false, reason: "Cannot delete a completed session" };
  }
  if (data.strava_activity_id) {
    return { allowed: false, reason: "Cannot delete a Strava-imported session" };
  }
  return { allowed: true };
}

export function registerDeleteSession(server: McpServer): void {
  // ── Single delete ──
  server.tool(
    "delete_session",
    "Delete a planned training session. Completed and Strava-imported sessions cannot be deleted.",
    {
      sessionId: z.string().min(1).describe("The diary session ID to delete"),
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
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

        const rateLimitError = checkWriteRateLimit(claims.sub);
        if (rateLimitError) {
          return {
            content: [{ type: "text" as const, text: `Error: ${rateLimitError}` }],
            isError: true,
          };
        }

        const profileId = claims.profile_id;
        const docRef = profileSubcollection(profileId, "diary").doc(params.sessionId);
        const snap = await docRef.get();

        if (!snap.exists) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Session not found" }) }],
            isError: true,
          };
        }

        const data = snap.data() as Record<string, unknown>;
        const guard = canDelete(data);
        if (!guard.allowed) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: guard.reason }) }],
            isError: true,
          };
        }

        await docRef.delete();

        logToolCall({
          requestId,
          tool: "delete_session",
          userPseudonym: claims.sub,
          latencyMs: Date.now() - start,
          success: true,
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              deletedSessionId: params.sessionId,
              message: `Session "${data.title || params.sessionId}" deleted`,
            }),
          }],
        };
      } catch (error) {
        logToolCall({
          requestId,
          tool: "delete_session",
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

  // ── Bulk delete ──
  server.tool(
    "delete_sessions",
    "Delete multiple planned training sessions at once (max 20). Returns per-session success/failure.",
    {
      sessionIds: z
        .array(z.string().min(1))
        .min(1)
        .max(20)
        .describe("Array of diary session IDs to delete (max 20)"),
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
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

        const rateLimitError = checkWriteRateLimit(claims.sub);
        if (rateLimitError) {
          return {
            content: [{ type: "text" as const, text: `Error: ${rateLimitError}` }],
            isError: true,
          };
        }

        const profileId = claims.profile_id;
        const diaryCol = profileSubcollection(profileId, "diary");

        // Process each deletion independently for per-session error reporting
        const results = await Promise.allSettled(
          params.sessionIds.map(async (sessionId) => {
            const docRef = diaryCol.doc(sessionId);
            const snap = await docRef.get();

            if (!snap.exists) {
              return { sessionId, success: false, error: "Session not found" };
            }

            const data = snap.data() as Record<string, unknown>;
            const guard = canDelete(data);
            if (!guard.allowed) {
              return { sessionId, success: false, error: guard.reason };
            }

            await docRef.delete();
            return { sessionId, success: true, title: data.title || sessionId };
          }),
        );

        const summary = results.map((r) => {
          if (r.status === "fulfilled") return r.value;
          return { sessionId: "unknown", success: false, error: r.reason?.message || "Unknown error" };
        });

        const deletedCount = summary.filter((s) => s.success).length;

        logToolCall({
          requestId,
          tool: "delete_sessions",
          userPseudonym: claims.sub,
          latencyMs: Date.now() - start,
          success: true,
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              deletedCount,
              totalRequested: params.sessionIds.length,
              results: summary,
            }, null, 2),
          }],
        };
      } catch (error) {
        logToolCall({
          requestId,
          tool: "delete_sessions",
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
