/**
 * MCP Tool: modify_training_session
 * Scope: training:write
 *
 * Adjusts a planned session: volume reduction, intensity changes, exercise
 * swaps, rescheduling.
 *
 * Migrated onto the coreToolsBridge (WS1.1, exercise naming plan 02/07/2026):
 * the direct Firestore body is gone. Each legacy modification maps onto a
 * core modify_session operation (scale / swap / reschedule); combined calls
 * apply the operations sequentially in the legacy order. The swap path now
 * resolves the replacement's identity through core's write-time ladder, so
 * the session carries a real exercise_id + provenance instead of keeping the
 * old id under a new name. This wrapper keeps auth, scope, rate-limit,
 * logging, and scrubbing only.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { checkWriteRateLimit } from "../../middleware/rate-limiter.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import { callCoreBridge } from "../shared/bridge_client.js";
import {
  EXERCISE_NAME_DESCRIPTION,
  bridgeFailureResponse,
  exerciseIdField,
  unwrapBridgeResult,
} from "../shared/core_adapter.js";
import { buildModifyTrainingOperations } from "./session_modify_mapping.js";
import { cardCallableToolMeta, cardsOn } from "../../cards/card_shell.js";
import { currentHostProfile, type HostProfile } from "../../cards/host.js";

export function registerModifyTrainingSession(server: McpServer): void {
  server.registerTool(
    "modify_training_session",
    {
      title: "Modify Training Session",
      description: "Adjust a planned session: reduce volume, change intensity, swap exercises, or reschedule to a different date. To move several sessions at once (for example after the athlete changes their training days), pass rescheduleSessions and they all move in one call.",
      inputSchema: {
        sessionId: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("The session ID (from get_training_overview or get_session_details). Required for every change except rescheduleSessions."),
        reduceVolume: z
          .number()
          .min(0.1)
          .max(1.0)
          .optional()
          .describe("Volume multiplier (e.g., 0.5 = halve all sets/reps, 0.75 = reduce by 25%)"),
        increaseIntensity: z
          .number()
          .min(0.5)
          .max(2.0)
          .optional()
          .describe("Intensity multiplier for weights (e.g., 1.1 = increase by 10%)"),
        swapExercise: z
          .object({
            from: z.string().min(1).max(200).describe("Name of the exercise to replace, as it appears in the session"),
            to: z.string().min(1).max(200).describe(EXERCISE_NAME_DESCRIPTION),
            toExerciseId: exerciseIdField,
          })
          .optional()
          .describe("Swap one exercise for another"),
        rescheduleDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
          .optional()
          .describe("New scheduled date in YYYY-MM-DD format"),
        rescheduleSessions: z
          .array(
            z.object({
              sessionId: z.string().min(1).max(200).describe("A planned session to move"),
              newDate: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
                .describe("Its new date in YYYY-MM-DD format"),
            }),
          )
          .min(1)
          .max(60)
          .optional()
          .describe("Move several planned sessions in one call, across any built weeks. The result lists which moved, which stayed and why, and which need the athlete to choose a day. Sessions the athlete moved by hand stay where they put them."),
      },
      // Not idempotent: reduceVolume and increaseIntensity scale the stored values, so a repeat compounds.
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false, title: "Modify Training Session" },
      // Not callable from a card: the Week card's Confirm calls card_reschedule_session,
      // which can only move a session.
    },
    async (params) => runModifyTrainingSession(params, "modify_training_session"),
  );
}

type ModifyParams = {
  sessionId?: string;
  reduceVolume?: number;
  increaseIntensity?: number;
  swapExercise?: { from: string; to: string; toExerciseId?: string };
  rescheduleDate?: string;
  rescheduleSessions?: Array<{ sessionId: string; newDate: string }>;
};

type ToolReply = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/**
 * The one modify path both tools share: auth and scope, the write rate limit, the
 * claims-derived profile (never a profile id from input), the core bridge, scrubbing.
 */
async function runModifyTrainingSession(params: ModifyParams, tool: string): Promise<ToolReply> {
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

        // Write rate limit
        const rateLimitError = checkWriteRateLimit(claims.sub);
        if (rateLimitError) {
          return {
            content: [{ type: "text" as const, text: `Error: ${rateLimitError}` }],
            isError: true,
          };
        }

        const singleChangeAsked = params.reduceVolume != null || params.increaseIntensity != null ||
          params.swapExercise != null || params.rescheduleDate != null;
        if (singleChangeAsked && params.sessionId == null) {
          return {
            content: [{ type: "text" as const, text: "Error: sessionId is required for reduceVolume, increaseIntensity, swapExercise and rescheduleDate" }],
            isError: true,
          };
        }

        const operations = buildModifyTrainingOperations({
          sessionId: params.sessionId,
          rescheduleSessions: params.rescheduleSessions,
          reduceVolume: params.reduceVolume,
          increaseIntensity: params.increaseIntensity,
          swapExercise: params.swapExercise,
          rescheduleDate: params.rescheduleDate,
        });
        if (operations.length === 0) {
          return {
            content: [{ type: "text" as const, text: "Error: At least one modification is required (reduceVolume, increaseIntensity, swapExercise, rescheduleDate, or rescheduleSessions)" }],
            isError: true,
          };
        }

        // profileId comes ONLY from validated claims, never from tool params.
        const profileId = claims.profile_id;

        const modifications: string[] = [];
        const updatedFields = new Set<string>();
        let title: unknown;
        let batch: Record<string, unknown> | undefined;

        for (const operation of operations) {
          const bridged = await callCoreBridge("modify_session", profileId, operation.input);
          const failure = bridgeFailureResponse(bridged, operation.action);
          if (failure) {
            // Earlier operations in this call have already been applied by
            // core; tell the agent so it corrects the remainder instead of
            // re-sending the whole combination.
            if (modifications.length > 0) {
              failure.content[0].text += `\n${JSON.stringify({ appliedModifications: modifications })}`;
            }
            logToolCall({
              requestId,
              tool,
              userPseudonym: claims.sub,
              latencyMs: Date.now() - start,
              success: false,
              error: bridged.error ?? "bridge_error",
            });
            return failure;
          }
          const result = unwrapBridgeResult(bridged);
          if (typeof result.message === "string") modifications.push(result.message);
          for (const field of (result.updatedFields as string[] | undefined) ?? []) {
            updatedFields.add(field);
          }
          if (result.title != null) title = result.title;
          if (result.type === "reschedule_many") {
            batch = {
              moved: result.moved ?? [],
              skipped: result.skipped ?? [],
              needsAthlete: result.needsAthlete ?? [],
              failed: result.failed ?? [],
            };
          }
        }

        const output = scrubDocument({
          sessionId: params.sessionId,
          title,
          modifications,
          updatedFields: [...updatedFields],
          ...(batch ?? {}),
          message: `Session modified successfully: ${modifications.join("; ")}`,
        });

        logToolCall({
          requestId,
          tool,
          userPseudonym: claims.sub,
          latencyMs: Date.now() - start,
          success: true,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        logToolCall({
          requestId,
          tool,
          latencyMs: Date.now() - start,
          success: false,
          error: (error as Error).message,
        });
        return {
          content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }],
          isError: true,
        };
      }
}

/** Card session ids: Pelaris ids are letters, digits, `_`, `-` and `.` (Firestore ids have no `/`). */
export const CARD_SESSION_ID = /^[A-Za-z0-9_.-]{1,200}$/;

/** A real calendar day as YYYY-MM-DD. */
export function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** The only input the card's move tool takes. Strict: any other key is refused. */
export const CARD_RESCHEDULE_INPUT = z
  .object({
    sessionId: z.string().regex(CARD_SESSION_ID, "Not a session id").describe("The planned session to move"),
    newDate: z.string().refine(isCalendarDay, "Must be a real date in YYYY-MM-DD format").describe("Its new date, YYYY-MM-DD"),
  })
  .strict();

export const CARD_RESCHEDULE_TOOL = "card_reschedule_session";

/**
 * `card_reschedule_session`: the Week card's Confirm. App-only (`visibility: ["app"]`):
 * the card may call it, and a host MUST NOT offer it to the model. It only moves one
 * planned session to a new day, through the same path as modify_training_session's
 * `rescheduleSessions`, and answers with the same `moved` / `skipped` / `needsAthlete` /
 * `failed` / `message` shape. Registered only for a host that draws cards (a host that
 * does not would not know to hide it from the model).
 */
export function registerCardRescheduleSession(server: McpServer, host: HostProfile = currentHostProfile()): void {
  if (!cardsOn(host)) return;
  server.registerTool(
    CARD_RESCHEDULE_TOOL,
    {
      title: "Move a session (week card)",
      description: "Used by the Pelaris week card when the athlete confirms a move: moves one planned session to a new day.",
      inputSchema: CARD_RESCHEDULE_INPUT,
      // A repeat of the same move finds the session already on that day and leaves it.
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true, title: "Move a session (week card)" },
      _meta: cardCallableToolMeta(process.env, host),
    },
    async (params) =>
      runModifyTrainingSession({ rescheduleSessions: [{ sessionId: params.sessionId, newDate: params.newDate }] }, CARD_RESCHEDULE_TOOL),
  );
}
