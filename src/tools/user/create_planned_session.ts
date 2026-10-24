/**
 * MCP Tool: create_planned_session
 * Scope: training:write
 *
 * Creates a planned diary entry for a future workout session via the wayfinder
 * core `create_planned_session` over the coreToolsBridge (WS1, 02/07/2026).
 * The core write path owns persistence: exercise identity resolution
 * (canonical exercise_id), same-day preflight, and native block structure.
 * This wrapper keeps auth, scope, rate limiting, logging, and scrubbing, and
 * adapts the legacy flat schema onto the core contract (core_adapter.ts).
 * The session appears in the Pelaris app's Train tab on the scheduled date,
 * with target exercises that the user can then track actuals against.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { checkWriteRateLimit } from "../../middleware/rate-limiter.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import { callCoreBridge, type BridgeResult } from "../shared/bridge_client.js";
import {
  EXERCISE_NAME_DESCRIPTION,
  bridgeFailureResponse,
  coreWriteBlocksField,
  exerciseIdField,
  mapLegacyPlannedExercise,
  resolveBlocksInput,
  unwrapBridgeResult,
  type CoreWriteBlockSpec,
  type LegacyPlannedExerciseFields,
} from "../shared/core_adapter.js";

const VALID_SPORTS = [
  "strength", "running", "swimming", "cycling",
  "triathlon", "crossfit", "other",
] as const;

/** Map MCP sport names to the session_type value echoed in the response.
 *  Response-shape parity only; the persisted session_type is derived
 *  server-side by the core write path. */
function mapSportToSessionType(sport: string): string {
  switch (sport) {
    case "running": return "run";
    case "swimming": return "swim";
    case "cycling": return "ride";
    case "crossfit": return "hiit";
    default: return sport; // strength, triathlon, other → pass through
  }
}

/** Tool params after zod validation. Exercises keep the legacy planned
 *  dialect (weight kg, duration SECONDS, distance meters) plus the additive
 *  exerciseId; blocks[] speak the core contract directly. */
export interface CreatePlannedSessionToolParams {
  date: string;
  sport: (typeof VALID_SPORTS)[number];
  title?: string;
  durationMinutes?: number;
  sessionFocus?: string;
  coachNote?: string;
  exercises?: LegacyPlannedExerciseFields[];
  blocks?: CoreWriteBlockSpec[];
  /** 1.4.1 D4: why this is a new, additional session rather than a change to an existing one. */
  explicitNewSessionReason?: string;
  /** 1.4.1 D4: an existing session to copy the structure of. */
  basedOnSessionId?: string;
}

/** The closed shape of the core's same-day preflight detail (`SessionWritePreflightDetail`). */
interface PreflightDetail {
  kind: "reject_use_modify_session" | "needs_disambiguation";
  target?: { id: string; title: string; date: string };
  candidates: Array<{ id: string; title: string; date: string }>;
}

function preflightDetailOf(detail: unknown): PreflightDetail | null {
  if (detail == null || typeof detail !== "object") return null;
  const d = detail as Record<string, unknown>;
  if (d.kind !== "reject_use_modify_session" && d.kind !== "needs_disambiguation") return null;
  const asCandidate = (c: unknown): { id: string; title: string; date: string } | null => {
    if (c == null || typeof c !== "object") return null;
    const r = c as Record<string, unknown>;
    return typeof r.id === "string"
      ? { id: r.id, title: typeof r.title === "string" ? r.title : "", date: typeof r.date === "string" ? r.date : "" }
      : null;
  };
  const candidates = (Array.isArray(d.candidates) ? d.candidates : [])
    .map(asCandidate)
    .filter((c): c is { id: string; title: string; date: string } => c !== null);
  const target = asCandidate(d.target);
  return { kind: d.kind, ...(target ? { target } : {}), candidates };
}

/**
 * 1.4.1 D4: the actionable text for the core's same-day preflight refusals
 * (`reject_use_modify_session`, `needs_disambiguation`), or null for any other
 * failure. It lists the candidate sessions as DATA and says exactly how to
 * proceed; it does not decide whether the new session is "the same" as one of
 * them. The model decides, from the candidates and the person's request
 * (AI-first: no title or token matching here).
 */
export function preflightGuidanceText(bridged: BridgeResult): string | null {
  if (bridged.ok) return null;
  const detail = preflightDetailOf(bridged.errorDetail);
  if (!detail) return null;
  const list = detail.candidates.length > 0 ? detail.candidates : detail.target ? [detail.target] : [];
  const lines = list.map((c) => `- ${c.id}: ${c.title || "Untitled session"} (${c.date})`);
  const headline = detail.kind === "reject_use_modify_session"
    ? "That day already has a planned session of the same sport, so nothing was created."
    : "That day already has more than one planned session of the same sport, so nothing was created.";
  return [
    `Error creating planned session: ${headline}`,
    "Sessions already planned that day:",
    ...lines,
    "How to proceed, choose one:",
    "1. To change one of these sessions, call modify_training_session with its id (the id at the start of the line).",
    "2. To add a separate, additional session on that day, call create_planned_session again with the same details plus " +
      "explicitNewSessionReason set to a short phrase saying why this is a new session and not a change to an existing one.",
    "3. To repeat or vary an existing session, call create_planned_session with basedOnSessionId set to that session's id; " +
      "anything else you pass overrides the copy.",
    "If the person's request does not make clear which they want, ask them.",
  ].join("\n");
}

/**
 * Build the core `create_planned_session` input from the tool params. Flat
 * legacy exercises[] are mapped field-by-field onto the core spec (weight ->
 * weightKg, duration seconds -> durationMinutes, distance -> distanceMeters)
 * and wrapped as per-exercise single blocks; explicit blocks[] pass through
 * untouched and win when both are present. Never includes any profile
 * identifier: profileId travels only as the separate bridge argument, from
 * validated claims. Exported for contract tests.
 */
export function buildCreatePlannedSessionCoreInput(
  params: CreatePlannedSessionToolParams,
): Record<string, unknown> {
  const blocks = resolveBlocksInput(
    params.blocks,
    params.exercises?.map(mapLegacyPlannedExercise),
  );
  return {
    date: params.date,
    sport: params.sport,
    ...(params.title ? { title: params.title } : {}),
    ...(params.durationMinutes != null ? { durationMinutes: params.durationMinutes } : {}),
    ...(params.sessionFocus ? { sessionFocus: params.sessionFocus } : {}),
    ...(params.coachNote ? { coachNote: params.coachNote } : {}),
    ...(blocks ? { blocks } : {}),
    ...(params.explicitNewSessionReason?.trim() ? { explicitNewSessionReason: params.explicitNewSessionReason.trim() } : {}),
    ...(params.basedOnSessionId?.trim() ? { basedOnSessionId: params.basedOnSessionId.trim() } : {}),
  };
}

export function registerCreatePlannedSession(server: McpServer): void {
  server.registerTool(
    "create_planned_session",
    {
      title: "Create Planned Session",
      description: "Schedule a future workout session with target exercises. The session will appear in your " +
        "training calendar ready to track. Express grouped work (supersets, circuits) and phases " +
        "(warm-up / main / cool-down) with blocks[].",
      inputSchema: {
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
          .describe("Scheduled date for the session (YYYY-MM-DD)"),
        sport: z
          .enum(VALID_SPORTS)
          .describe("Sport/activity type"),
        title: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Session title (defaults to '{Sport} Session')"),
        durationMinutes: z
          .number()
          .int()
          .min(1)
          .max(480)
          .optional()
          .describe("Estimated duration in minutes (1-480)"),
        sessionFocus: z
          .string()
          .max(200)
          .optional()
          .describe("Focus description, e.g. 'Upper Body Strength', 'Threshold Intervals'"),
        coachNote: z
          .string()
          .max(1000)
          .optional()
          .describe("Coaching context explaining why this session matters"),
        exercises: z
          .array(
            z.object({
              name: z.string().min(1).max(200).describe(EXERCISE_NAME_DESCRIPTION),
              exerciseId: exerciseIdField,
              sets: z.number().int().min(1).max(50).optional().describe("Number of sets"),
              reps: z.number().int().min(1).max(200).optional().describe("Target reps per set"),
              weight: z.number().min(0).max(1000).optional().describe("Target weight in kg"),
              duration: z.number().int().min(0).max(36000).optional().describe("Duration in seconds (for cardio/timed exercises)"),
              distance: z.number().min(0).max(100000).optional().describe("Distance in meters"),
              notes: z.string().max(500).optional().describe("Exercise-specific notes"),
            }),
          )
          .max(30)
          .optional()
          .describe("Array of planned exercises (max 30). Flat list of standalone movements; use blocks[] for grouped or phased sessions. Use plain movement names only; never encode grouping (supersets, circuits) in exercise names."),
        blocks: coreWriteBlocksField,
        explicitNewSessionReason: z
          .string()
          .max(200)
          .optional()
          .describe(
            "Why this is a new, additional session rather than a change to an existing one. Needed only when that " +
            "day already has a planned session of the same sport and the person wants a separate extra one. " +
            "If you omit it, the refusal lists the sessions already planned that day and how to proceed.",
          ),
        basedOnSessionId: z
          .string()
          .max(120)
          .optional()
          .describe(
            "Optional. The id of an existing session (from get_session_details or get_active_program) to copy the " +
            "structure of. Anything else you pass (date, title, blocks) overrides the copy.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false, title: "Create Planned Session" },
    },
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

        // Write rate limit
        const rateLimitError = checkWriteRateLimit(claims.sub);
        if (rateLimitError) {
          return {
            content: [{ type: "text" as const, text: `Error: ${rateLimitError}` }],
            isError: true,
          };
        }

        // profileId comes only from validated claims, never from tool params.
        const bridged = await callCoreBridge(
          "create_planned_session",
          claims.profile_id,
          buildCreatePlannedSessionCoreInput(params),
        );

        const failure = bridgeFailureResponse(bridged, "creating planned session");
        if (failure) {
          const guidance = preflightGuidanceText(bridged);
          if (guidance) failure.content = [{ type: "text" as const, text: guidance }];
          logToolCall({
            requestId,
            tool: "create_planned_session",
            userPseudonym: claims.sub,
            latencyMs: Date.now() - start,
            success: false,
            error: bridged.error ?? "unknown error",
          });
          return failure;
        }

        // Core returns CreatePlannedSessionOutput; echo the response shape
        // users of this tool already get.
        const core = unwrapBridgeResult(bridged) as {
          sessionId?: string;
          status?: string;
          date?: string;
          title?: string;
          exerciseCount?: number;
        };
        const sessionTitle = core.title ??
          params.title ??
          `${params.sport.charAt(0).toUpperCase() + params.sport.slice(1)} Session`;
        const sessionDate = core.date ?? params.date;

        const result = scrubDocument({
          sessionId: core.sessionId,
          status: core.status ?? "created",
          date: sessionDate,
          title: sessionTitle,
          sport: params.sport,
          sessionType: mapSportToSessionType(params.sport),
          exerciseCount: core.exerciseCount ?? 0,
          message: `Planned session created: "${sessionTitle}" on ${sessionDate}. It will appear in the Train tab for tracking.`,
        });

        logToolCall({
          requestId,
          tool: "create_planned_session",
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
          tool: "create_planned_session",
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
