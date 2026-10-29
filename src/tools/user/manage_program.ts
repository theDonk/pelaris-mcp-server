/**
 * MCP Tool: manage_program (archive only)
 * Scope: training:write
 *
 * Read-only actions (get_current, list_history) moved to get_program_status.
 * This tool only handles archive, so destructiveHint:true is appropriate.
 *
 * Connector rev 2.1: archive goes through
 * Pelaris's own core tool `archive_program` over the core bridge, which asks the app's Remove
 * and nothing else. This file no longer touches the program's documents. The old archive wrote a
 * marker only this server read, never touched the person's active-program list, and left a
 * dangling pointer (the 16/10 incident). Now:
 *
 * - a program the person has not started, inside its free window, is removed exactly as the
 *   app's Remove does it (free, nothing deleted);
 * - everything Remove declines (a started program, an unstarted one past its window, a template
 *   plan) answers one closed outcome, `open_in_app`: Pause, Stop and Remove are in the app under
 *   Profile, and the reply carries the link that opens Pelaris;
 * - a program already replaced answers `already_replaced`; with several programs and no
 *   `programId` the person is asked which one.
 *
 * Every reply is a fixed sentence the core or this file wrote. The typed id and raw errors are
 * never echoed. The profile id comes from the token, never from the input.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { checkWriteRateLimit } from "../../middleware/rate-limiter.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import { callCoreBridge, type BridgeResult } from "../shared/bridge_client.js";
import { ENTRY_LINK_PROGRAM, ENTRY_LINK_TRAIN } from "../shared/entry_links.js";

export const MANAGE_PROGRAM_DESCRIPTION =
  "Set a training program aside the way the Pelaris app does. A program the athlete has not started yet " +
  "is removed, as long as it is still free to remove: nothing is deleted. For anything else, such as a " +
  "program they have started, the athlete chooses Pause, Stop or Remove in the Pelaris app under Profile, " +
  "and this tool says so and gives the link. If they have more than one program and you do not pass a " +
  "programId, this tool lists them: ask which one and call again with its programId. If a reply asks you " +
  "to try again, call again with the same programId.";

/** The fixed sentences this file adds to the core's own. Never an id, a title or a raw error. */
export const ARCHIVE_SENTENCES = {
  notFound: "I could not find that program on your list. Ask to see your programs and I will pick the right one.",
  permissionDenied: "Your account is being deleted, so programs cannot be changed.",
  missingArg: "I could not read which program you meant. Ask to see your programs and tell me which one to set aside.",
  choose: "You have more than one program. Which one should I set aside?",
  tryAgain: "I could not finish that just now. Please try again in a moment.",
  /**
   * With `refund_pending` the program is already removed, and a repeat must name it: with no programId the
   * core finds no running program (a removed one is no longer on the running list). `get_program_status`
   * lists it, with its programId and the status `removed`.
   */
  howToRetry:
    "Call manage_program again with the same programId. If you did not pass one, find it with " +
    "get_program_status (action list_history): it is the program whose status is removed.",
} as const;

/** The closed success outcomes of the core tool (`archive_program`). */
const OUTCOMES = ["removed", "refund_pending", "open_in_app", "already_replaced"] as const;
type ArchiveOutcome = (typeof OUTCOMES)[number];

/** Which outcomes carry a link: after a remove, build a fresh program; otherwise open the program in the app. */
const LINK_OF_OUTCOME: Readonly<Partial<Record<ArchiveOutcome, string>>> = {
  removed: ENTRY_LINK_PROGRAM,
  open_in_app: ENTRY_LINK_TRAIN,
};

/** The athlete's own program states, as the core names them, in plain words for the assistant. */
const STATE_WORDS: Readonly<Record<string, string>> = {
  active: "running",
  resting: "resting",
  paused_by_person: "paused",
};

/** A display cap, like the core's. */
const MAX_CHOICES = 6;
const MAX_CANDIDATES_SCANNED = 50;
const MAX_TITLE_CHARS = 80;
const MAX_ID_CHARS = 200;

export interface MappedArchive {
  /** The text the assistant receives. */
  text: string;
  isError: boolean;
  /** Counts as a good call in the log (an expected path such as a program choice is good). */
  success: boolean;
  /** A closed code for the log: the outcome, or why it failed. Never a message. */
  code: string;
}

const failure = (code: string, sentence: string): MappedArchive => ({
  text: `Error: ${sentence}`,
  isError: true,
  success: false,
  code,
});

/** The fixed "try again" answer for anything that is not a clean answer from the core. */
export function archiveTryAgain(code: string): MappedArchive {
  return failure(code, ARCHIVE_SENTENCES.tryAgain);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function programChoicesOf(detail: unknown): Array<{ programId: string; title: string | null; state: string | null }> {
  const candidates = isRecord(detail) ? detail["candidates"] : undefined;
  if (!Array.isArray(candidates)) return [];
  const choices: Array<{ programId: string; title: string | null; state: string | null }> = [];
  // Keep the first valid ones up to the cap (junk entries do not use it up); the scan itself is bounded.
  for (const candidate of candidates.slice(0, MAX_CANDIDATES_SCANNED)) {
    if (choices.length >= MAX_CHOICES) break;
    if (!isRecord(candidate)) continue;
    const id = candidate["queueId"];
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_CHARS) continue;
    const title = typeof candidate["title"] === "string" ? candidate["title"].trim().slice(0, MAX_TITLE_CHARS) : "";
    const state = candidate["state"];
    choices.push({
      programId: id,
      title: title.length > 0 ? title : null,
      state: typeof state === "string" ? (STATE_WORDS[state] ?? null) : null,
    });
  }
  return choices;
}

/**
 * Map the core bridge's envelope to what the assistant receives. Pure. Success outcomes relay the
 * core's own sentence word for word; every refusal is a fixed sentence; an unknown code or a
 * malformed envelope is the single "try again" sentence. The typed id is never echoed.
 */
export function mapArchiveResult(envelope: unknown): MappedArchive {
  if (!isRecord(envelope)) return archiveTryAgain("malformed_reply");

  if (envelope["ok"] === true) {
    const result = envelope["result"];
    const outcome = isRecord(result) ? result["outcome"] : undefined;
    const message = isRecord(result) ? result["message"] : undefined;
    if (typeof outcome !== "string" || !(OUTCOMES as readonly string[]).includes(outcome)) {
      return archiveTryAgain("malformed_result");
    }
    if (typeof message !== "string" || message.trim().length === 0) return archiveTryAgain("malformed_result");
    const link = LINK_OF_OUTCOME[outcome as ArchiveOutcome];
    const body = scrubDocument({
      status: outcome,
      message,
      ...(link ? { link } : {}),
      ...(outcome === "refund_pending" ? { how_to_retry: ARCHIVE_SENTENCES.howToRetry } : {}),
    });
    return { text: JSON.stringify(body, null, 2), isError: false, success: true, code: outcome };
  }

  switch (envelope["error"]) {
    case "not_found":
      return failure("not_found", ARCHIVE_SENTENCES.notFound);
    case "permission_denied":
      return failure("permission_denied", ARCHIVE_SENTENCES.permissionDenied);
    case "missing_required_arg":
      return failure("missing_required_arg", ARCHIVE_SENTENCES.missingArg);
    case "needs_program_choice": {
      // An expected path, like intake's clarification: not an error. Titles are the person's own, scrubbed.
      const body = scrubDocument({
        status: "needs_program_choice",
        message: ARCHIVE_SENTENCES.choose,
        programs: programChoicesOf(envelope["errorDetail"]),
      });
      return { text: JSON.stringify(body, null, 2), isError: false, success: true, code: "needs_program_choice" };
    }
    case "archive_failed":
      return archiveTryAgain("archive_failed");
    case "tool_not_allowed":
      // The functions release that adds `archive_program` is not deployed yet.
      return archiveTryAgain("tool_not_allowed");
    default:
      return archiveTryAgain("unknown_error");
  }
}

/**
 * The closed log code for a THROWN bridge error (the HTTP client throws on a non-2xx answer):
 * a 403 is the core not knowing `archive_program` yet, a 401 is the service identity, anything
 * else is the network. The reply is the same fixed sentence for all of them.
 */
export function thrownBridgeCodeOf(error: unknown): string {
  const status = isRecord(error)
    ? (isRecord(error["response"]) ? error["response"]["status"] : undefined) ?? error["status"]
    : undefined;
  if (status === 403) return "tool_not_allowed";
  if (status === 401) return "bridge_unauthenticated";
  return "bridge_unreachable";
}

/** The seam the tests use; production calls the core bridge. */
export interface ManageProgramDeps {
  callBridge: (tool: string, profileId: string, input: Record<string, unknown>) => Promise<BridgeResult>;
}

const DEFAULT_DEPS: ManageProgramDeps = { callBridge: callCoreBridge };

export function registerManageProgram(server: McpServer, deps: ManageProgramDeps = DEFAULT_DEPS): void {
  server.registerTool(
    "manage_program",
    {
      title: "Manage Program",
      description: MANAGE_PROGRAM_DESCRIPTION,
      inputSchema: {
        action: z
          .literal("archive")
          .describe("Set a program aside"),
        programId: z
          .string()
          .max(200)
          .optional()
          .describe("The program's id (from the list this tool returns). Omit it when the athlete has one program"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true, title: "Manage Program" },
    },
    async (params) => {
      const requestId = generateRequestId();
      const start = Date.now();
      // Read before the try so every path, the catch included, can name the pseudonym.
      const claims = getRequestAuth();
      const log = (success: boolean, code: string, extras?: Record<string, unknown>) =>
        logToolCall({
          requestId,
          tool: "manage_program",
          userPseudonym: claims?.sub,
          latencyMs: Date.now() - start,
          success,
          ...(success ? {} : { error: code }),
          extras: { archive_result: code, ...(extras ?? {}) },
        });
      const reply = (mapped: MappedArchive) => ({
        content: [{ type: "text" as const, text: mapped.text }],
        ...(mapped.isError ? { isError: true } : {}),
      });

      try {
        if (!claims || !hasScope(claims.scope, "training:write")) {
          log(false, "scope_required");
          return reply({ text: "Error: training:write scope required", isError: true, success: false, code: "scope_required" });
        }
        const rateLimitError = checkWriteRateLimit(claims.sub);
        if (rateLimitError) {
          log(false, "rate_limited");
          return reply({ text: `Error: ${rateLimitError}`, isError: true, success: false, code: "rate_limited" });
        }

        let envelope: unknown;
        try {
          // The profile id is the token's own; the input carries only the program the person named.
          envelope = await deps.callBridge("archive_program", claims.profile_id, params.programId ? { queueId: params.programId } : {});
        } catch (error) {
          const mapped = archiveTryAgain(thrownBridgeCodeOf(error));
          log(false, mapped.code, { error_name: error instanceof Error ? error.name : "unknown" });
          return reply(mapped);
        }

        const mapped = mapArchiveResult(envelope);
        log(mapped.success, mapped.code);
        return reply(mapped);
      } catch (error) {
        // The error's name only: its message can carry a path or an id.
        const mapped = archiveTryAgain("manage_program_failed");
        log(false, mapped.code, { error_name: error instanceof Error ? error.name : "unknown" });
        return reply(mapped);
      }
    },
  );
}
