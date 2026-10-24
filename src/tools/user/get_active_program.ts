/**
 * MCP Tool: get_active_program
 * Scope: training:read
 *
 * Returns the user's active training program(s) with structure details.
 *
 * 1.4.1 D2 (connector truth, PEL-1211): the week, phase, schedule, build state and
 * completion come from the app's backend (`get_training_truth` over the
 * coreToolsBridge), the same answer the app shows. This tool no longer works out a
 * week from the queue's sessions. It still reads the queue documents for the fields
 * the truth does not carry (type, weekly overviews, per-session coach-note flags).
 * Existing output fields keep their names; plain-language fields are added.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getActiveQueueDocuments } from "../../firestore-client.js";
import { scrubDocument } from "../../scrubber.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import { NO_RUNNING_PROGRAM_MESSAGE } from "../shared/program-utils.js";
import {
  TRUTH_UNAVAILABLE_MESSAGE,
  programTruthFields,
  readTrainingTruth,
  type TruthProgram,
  type TruthReader,
} from "../shared/training_truth.js";

type Raw = Record<string, unknown>;

/** The reads this tool makes, injectable for tests. */
export interface ActiveProgramDeps {
  truth: TruthReader;
  queueDocs: (profileId: string) => Promise<{ queueDocs: Array<{ id: string; data: () => Raw | undefined }> }>;
}

const DEFAULT_DEPS: ActiveProgramDeps = {
  truth: readTrainingTruth,
  queueDocs: getActiveQueueDocuments,
};

/**
 * One program's answer: the existing field names, filled from the truth, plus the
 * added plain-language fields. Pure (exported for tests).
 */
export function shapeActiveProgram(truth: TruthProgram, queue: Raw | undefined): Raw {
  const sessionFlags = new Map<string, Raw>();
  for (const s of (queue?.sessions as Raw[] | undefined) ?? []) {
    if (typeof s.id === "string") sessionFlags.set(s.id, s);
  }
  const isProgram = truth.kind === "program";
  return {
    programId: truth.queueId,
    title: truth.title,
    type: (queue?.type as string | undefined) ?? null,
    totalSessions: truth.completion.sessionsTotal,
    completedSessions: truth.completion.sessionsCompleted,
    completionPercent: truth.completion.completionPercent,
    // The program's declared length when it has one (a rolling program builds later weeks as you train).
    totalWeeks: isProgram ? (truth.declaredWeeks ?? truth.builtThroughWeek) : 0,
    currentWeek: truth.currentWeek,
    currentPhase: truth.phase ? { phase: truth.phase.phase, focus: truth.phase.focus } : null,
    currentWeekSessions: truth.currentWeekSessions.map((s) => {
      const flags = s.sessionId != null ? sessionFlags.get(s.sessionId) : undefined;
      return {
        sessionId: s.sessionId,
        focus: s.focus,
        slotType: s.slotType,
        isCompleted: s.isCompleted,
        scheduledDate: s.scheduledDate,
        hasCoachNote: !!flags?.coach_note,
        adaptationApplied: (flags?.adaptation_applied as boolean | undefined) ?? false,
      };
    }),
    weeklyOverviews: queue?.weekly_overviews ?? null,
    generationStatus: truth.generationStatus,
    ...programTruthFields(truth),
  };
}

export function registerGetActiveProgram(server: McpServer, deps: ActiveProgramDeps = DEFAULT_DEPS): void {
  server.registerTool(
    "get_active_program",
    {
      title: "Get Active Program",
      description: "View your current training programs with progress, phase, weekly structure, and session details.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, title: "Get Active Program" },
    },
    async () => {
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

        // PEL-220: Use profile.active_queues as source of truth (matches Flutter app)
        const [truth, { queueDocs }] = await Promise.all([deps.truth(profileId), deps.queueDocs(profileId)]);

        if (queueDocs.length === 0) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ programs: [], message: NO_RUNNING_PROGRAM_MESSAGE }) }],
          };
        }
        if (truth == null) {
          logToolCall({ requestId, tool: "get_active_program", userPseudonym: claims.sub, latencyMs: Date.now() - start, success: false, error: "truth_unavailable" });
          return { content: [{ type: "text" as const, text: `Error: ${TRUTH_UNAVAILABLE_MESSAGE}` }], isError: true };
        }

        const queueById = new Map(queueDocs.map((doc) => [doc.id, doc.data()]));
        const programs = truth.programs.map((p) => shapeActiveProgram(p, queueById.get(p.queueId)));

        const result = scrubDocument({
          programs,
          primaryProgramId: truth.primaryQueueId,
          asOf: truth.asOf,
          today: truth.today,
        } as Record<string, unknown>);

        logToolCall({
          requestId,
          tool: "get_active_program",
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
          tool: "get_active_program",
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
