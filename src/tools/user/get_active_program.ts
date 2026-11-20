/**
 * MCP Tool: get_active_program
 * Scope: training:read
 *
 * Returns the user's active training program(s) with structure details.
 *
 * 1.4.1 D2 (connector truth): the week, phase, schedule, build state and
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
import { NO_RUNNING_PROGRAM_MESSAGE, adaptationFieldsFor, withSignedAdaptationLink } from "../shared/program-utils.js";
import { mintSignedEntryLink, type HandoffClaimsLike } from "../shared/entry_links.js";
import { cardsOn, cardToolMeta, withCard } from "../../cards/card_shell.js";
import { currentHostProfile, type HostProfile } from "../../cards/host.js";
import { WEEK_CARD, WEEK_CARD_OPEN_ROUTE, buildWeekCardData } from "../../cards/week_card.js";
import {
  TRUTH_UNAVAILABLE_MESSAGE,
  WEEK_MEANING_NOTE,
  nextWeekFields,
  type TruthWeekSession,
  programTruthFields,
  readTrainingTruth,
  type TruthProgram,
  type TruthReader,
} from "../shared/training_truth.js";

type Raw = Record<string, unknown>;

type TextReply = { content: Array<{ type: "text"; text: string }>; isError?: boolean; _meta?: Record<string, unknown> };

/**
 * Adds the Week card to a successful reply. The text stays exactly as it was; the card's
 * data rides in the result's _meta. The one-tap link is minted only when a card is
 * drawn, and any failure leaves the plain text reply.
 */
export async function withWeekCard(
  reply: TextReply,
  result: Record<string, unknown>,
  claims: HandoffClaimsLike | null | undefined,
  mint: typeof mintSignedEntryLink = mintSignedEntryLink,
  host: HostProfile = currentHostProfile(),
): Promise<TextReply> {
  // No card work at all (no link minted) for a text-only host or with the switch off.
  if (!cardsOn(host)) return reply;
  try {
    const data = buildWeekCardData(result, null);
    if (!data) return reply;
    const openUrl = await mint(WEEK_CARD_OPEN_ROUTE, claims).catch(() => null);
    return withCard(reply, WEEK_CARD, { ...data, openUrl }, process.env, host);
  } catch {
    return reply;
  }
}

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
  const withFlags = (s: TruthWeekSession) => {
    const flags = s.sessionId != null ? sessionFlags.get(s.sessionId) : undefined;
    return {
      sessionId: s.sessionId,
      focus: s.focus,
      slotType: s.slotType,
      isCompleted: s.isCompleted,
      scheduledDate: s.scheduledDate,
      // Only when the server sent a stored length (mostly absent); never estimated here.
      ...(typeof s.durationMinutes === "number" && Number.isFinite(s.durationMinutes) ? { durationMinutes: s.durationMinutes } : {}),
      hasCoachNote: !!flags?.coach_note,
      adaptationApplied: (flags?.adaptation_applied as boolean | undefined) ?? false,
    };
  };
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
    currentWeekSessions: truth.currentWeekSessions.map(withFlags),
    ...nextWeekFields(truth, withFlags),
    weeklyOverviews: queue?.weekly_overviews ?? null,
    generationStatus: truth.generationStatus,
    ...programTruthFields(truth),
    ...adaptationFieldsFor(queue ?? {}, truth.buildState),
  };
}

export function registerGetActiveProgram(server: McpServer, deps: ActiveProgramDeps = DEFAULT_DEPS): void {
  server.registerTool(
    "get_active_program",
    {
      title: "Get Active Program",
      description:
        "View your current training programs with progress, phase, weekly structure, and session details. " +
        "Weeks are Monday to Sunday in your own timezone, \"Week N\" is the number the Pelaris app shows, and next week is the following Monday to Sunday.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, title: "Get Active Program" },
      ...(cardToolMeta(WEEK_CARD) ? { _meta: cardToolMeta(WEEK_CARD) } : {}),
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

        // Use profile.active_queues as source of truth (matches Flutter app)
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
        const programs = await withSignedAdaptationLink(
          truth.programs.map((p) => shapeActiveProgram(p, queueById.get(p.queueId))),
          claims,
        );

        const result = scrubDocument({
          weekNote: WEEK_MEANING_NOTE,
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

        return withWeekCard(
          { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] },
          result,
          claims,
        );
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
