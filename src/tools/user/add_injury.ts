/**
 * MCP Tool: record_injury
 * Scope: health:write
 *
 * Records, updates or resolves an injury on the user's profile. The write is the
 * wayfinder core's `update_athlete` (type "injury") over the coreToolsBridge, the
 * same implementation the in-app coach uses: this tool no longer writes
 * Firestore itself (1.4 B2c, IJ-3b). Two things followed from the old
 * direct write: it kept writing `training_context.injury_history = true` after
 * the core stopped (the boolean overwrote the athlete's own words), and it
 * answered an unknown body part by echoing the typed text back, which the
 * gateway and the error bridge then logged.
 *
 * - `add` (the default) records a new injury and returns its `injuryId`.
 * - `update` changes severity, side, notes or affected exercises of an entry.
 * - `resolve` marks it healed (`is_active: false`); the entry is kept, never
 *   deleted.
 * Ownership: only the token's own `claims.profile_id` is ever sent, and the tool
 * pins `type: "injury"` itself, so a caller cannot reach another branch of the
 * core tool or another profile. A bridge failure returns the core's closed error
 * code (for example `unknown_body_part`), never the typed input, and there is no
 * direct-write fallback.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { checkWriteRateLimit } from "../../middleware/rate-limiter.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import { callCoreBridge } from "../shared/bridge_client.js";

const VALID_SIDES = ["left", "right", "bilateral"] as const;

const SEVERITY_LEVELS = ["mild", "moderate", "severe"] as const;

const INJURY_ACTIONS = ["add", "update", "resolve"] as const;

/** An injury id as the core issues it: `inj_` and ten lowercase hex characters. */
const INJURY_ID = /^inj_[0-9a-f]{10}$/;

export const RECORD_INJURY_DESCRIPTION =
  "Log an injury or pain point so your training plan adapts automatically. Returns a coaching note and an injuryId. " +
  "To change one later, call again with action 'update' and its injuryId (for example a worse severity); when it has healed, " +
  "call with action 'resolve' and the injuryId: the entry is kept and stops shaping training. " +
  "Get injury ids from this tool's response or from get_training_context's activeInjuries.";

export function registerAddInjury(server: McpServer): void {
  server.registerTool(
    "record_injury",
    {
      title: "Record Injury",
      description: RECORD_INJURY_DESCRIPTION,
      inputSchema: {
        action: z
          .enum(INJURY_ACTIONS)
          .optional()
          .describe("add (the default) records a new injury; update changes one; resolve marks one healed"),
        injuryId: z
          .string()
          .regex(INJURY_ID, "Must be an injury id like inj_0123456789")
          .optional()
          .describe("Required for update and resolve: the id of the injury entry"),
        bodyPart: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe("Required to add. Body part affected by the injury (e.g. 'knee', 'left knee', 'lower_back')"),
        side: z
          .enum(VALID_SIDES)
          .optional()
          .describe("Side of the body affected (left/right/bilateral). Auto-detected if included in bodyPart."),
        severity: z
          .enum(SEVERITY_LEVELS)
          .optional()
          .describe("Required to add. Injury severity: mild (discomfort), moderate (limited movement), severe (cannot train)"),
        notes: z
          .string()
          .max(500)
          .optional()
          .describe("Additional details about the injury (when it occurred, what aggravates it)"),
        affectedExercises: z
          .array(z.string().min(1).max(200))
          .max(10)
          .optional()
          .describe("Specific exercises that aggravate the injury"),
        onsetDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
          .optional()
          .describe("When the injury occurred (YYYY-MM-DD)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false, title: "Record Injury" },
    },
    async (params) => {
      const requestId = generateRequestId();
      const start = Date.now();

      try {
        // Auth & scope check
        const claims = getRequestAuth();
        if (!claims || !hasScope(claims.scope, "health:write")) {
          return {
            content: [{ type: "text" as const, text: "Error: health:write scope required" }],
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

        const action = params.action ?? "add";
        // The core's update_athlete, branch "injury", for the token's own profile only.
        const bridged = await callCoreBridge("update_athlete", claims.profile_id, {
          type: "injury",
          action,
          ...(params.injuryId ? { injuryId: params.injuryId } : {}),
          ...(params.bodyPart ? { bodyPart: params.bodyPart } : {}),
          ...(params.side ? { side: params.side } : {}),
          ...(params.severity ? { severity: params.severity } : {}),
          ...(params.notes !== undefined ? { notes: params.notes } : {}),
          ...(params.affectedExercises ? { affectedExercises: params.affectedExercises } : {}),
          ...(params.onsetDate ? { onsetDate: params.onsetDate } : {}),
        });

        if (!bridged.ok || bridged.result == null) {
          // The core's message is a closed code (unknown_body_part, unknown_injury_id,
          // invalid_injury_input, ...), never the typed input. No direct-write fallback.
          logToolCall({
            requestId,
            tool: "add_injury",
            latencyMs: Date.now() - start,
            success: false,
            error: bridged.error ?? "bridge_failed",
          });
          return {
            content: [{ type: "text" as const, text: `Error: ${bridged.error ?? "unknown error"}` }],
            isError: true,
          };
        }

        const core = bridged.result as Record<string, unknown>;
        // An explicit allow-list: only the outcome fields that help the caller proceed.
        const result = scrubDocument({
          action,
          ...(core.injuryId !== undefined ? { injuryId: core.injuryId } : {}),
          ...(core.bodyPart !== undefined ? { bodyPart: core.bodyPart } : {}),
          ...(core.side !== undefined ? { side: core.side } : {}),
          ...(core.severity !== undefined ? { severity: core.severity } : {}),
          isActive: action !== "resolve",
          ...(core.coachingNote !== undefined ? { coachingNote: core.coachingNote } : {}),
          ...(action === "add" ? { affectedExercises: params.affectedExercises || [] } : {}),
          message: core.message,
        });

        logToolCall({
          requestId,
          tool: "add_injury",
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
          tool: "add_injury",
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
