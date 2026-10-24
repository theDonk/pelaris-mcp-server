/**
 * MCP Tool: get_program_status
 * Scope: training:read
 *
 * PEL-221: Split from manage_program. Read-only program queries that don't need
 * destructive approval. Shows current active programs or full program history.
 *
 * Connector rev 2.1 (M2): each program's `status` is the app's own reading of the person's list
 * (running, resting, paused, replaced, removed), so a program Remove took away is never listed as
 * running. A paused program is not "running", so `get_current` does not list it; the empty answer
 * says where it is.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, getActiveQueueDocuments, profileSubcollection } from "../../firestore-client.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import { NO_RUNNING_PROGRAM_MESSAGE, entriesByQueueId, summarizeProgram } from "../shared/program-utils.js";

const VALID_ACTIONS = ["get_current", "list_history"] as const;

type Raw = Record<string, unknown>;

/** The reads this tool makes, injectable for tests; production reads the person's own documents. */
export interface ProgramStatusDeps {
  /** The programs the person's list marks running, with their profile. */
  activePrograms: (profileId: string) => Promise<{ profileData: Raw; queueDocs: FirebaseFirestore.DocumentSnapshot[] }>;
  /** Their latest programs, newest first, with their profile (for each program's entry in their list). */
  history: (profileId: string) => Promise<{ profileData: Raw; docs: FirebaseFirestore.QueryDocumentSnapshot[] }>;
}

const DEFAULT_DEPS: ProgramStatusDeps = {
  activePrograms: getActiveQueueDocuments,
  history: async (profileId) => {
    const [profileSnap, queuesSnap] = await Promise.all([
      db.collection("profiles").doc(profileId).get(),
      profileSubcollection(profileId, "queues").orderBy("date_created", "desc").limit(20).get(),
    ]);
    return { profileData: (profileSnap.exists ? profileSnap.data() : {}) as Raw, docs: queuesSnap.docs };
  },
};

export function registerGetProgramStatus(server: McpServer, deps: ProgramStatusDeps = DEFAULT_DEPS): void {
  server.registerTool(
    "get_program_status",
    {
      title: "Get Program Status",
      description: "View your running training programs or browse your program history, including paused, replaced and removed programs, each with its status.",
      inputSchema: {
        action: z
          .enum(VALID_ACTIONS)
          .describe("get_current: show running programs. list_history: show all programs with their status (running, resting, paused, replaced, removed)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, title: "Get Program Status" },
    },
    async (params) => {
      const requestId = generateRequestId();
      const start = Date.now();
      // Read before the try so every path, the empty answers and the catch included, can name the pseudonym
      // (end to end run 22/10/2026: the two "nothing to list" answers returned without any log line).
      const claims = getRequestAuth();
      const logOk = () =>
        logToolCall({ requestId, tool: "get_program_status", userPseudonym: claims?.sub, latencyMs: Date.now() - start, success: true });

      try {
        if (!claims || !hasScope(claims.scope, "training:read")) {
          return {
            content: [{ type: "text" as const, text: "Error: training:read scope required" }],
            isError: true,
          };
        }

        const profileId = claims.profile_id;

        if (params.action === "get_current") {
          // PEL-220: Use profile.active_queues as source of truth
          const { profileData, queueDocs } = await deps.activePrograms(profileId);

          if (queueDocs.length === 0) {
            logOk();
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ programs: [], message: NO_RUNNING_PROGRAM_MESSAGE }) }],
            };
          }

          const entries = entriesByQueueId(profileData);
          const programs = queueDocs.map((doc) => summarizeProgram(doc, entries));
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
        const { profileData, docs } = await deps.history(profileId);

        if (docs.length === 0) {
          logOk();
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ programs: [], message: "No programs found" }) }],
          };
        }

        const entries = entriesByQueueId(profileData);
        const programs = docs.map((doc) => summarizeProgram(doc, entries));
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
          userPseudonym: claims?.sub,
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
