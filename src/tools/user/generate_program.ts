/**
 * MCP Tool: generate_program (a reply-only tool since connector rev 2.1, 22/10/2026)
 * Scope: training:read or training:write
 *
 * Programs are built in Pelaris, not in a chat (Brad 20/10/2026, BRAD_RETURN #46).
 * This tool stays listed under its old name so an assistant that is asked for a
 * program explains and hands over a link instead of failing. It writes nothing,
 * starts no job and calls nothing outside this server: it reads the person's
 * profile once and answers with the First Light entry link that opens Pelaris at
 * the right place (`../shared/entry_links.ts`).
 *
 * Why: on 16/10 a long build held open as one request, retried by an assistant
 * whose clock was shorter than the job, produced four programs for one person in
 * ten minutes and left their active-program pointer dangling
 * (`design_docs/release_1_4_2026_10/mcp_generation_rca/DESIGN.md`). The app's own
 * build path is reliable; the connector now hands people to it. The long-build
 * limiter in `middleware/rate-limiter.ts` is kept for the future ticket that lets
 * the connector build again, and is not called from here.
 *
 * The reply is decided from two stored facts, read the way `get_onboarding_status`
 * reads them (`onboardingFactsOf`: the intake marker and the app's `hasPlan` rule
 * through the gateway's pinned copy), through that tool's own `next_step` mapping.
 * No text is matched and no threshold decides anything: the model decides what the
 * person asked for, this code reports where they stand.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { db } from "../../firestore-client.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import { ENTRY_LINK_PROGRAM, ENTRY_LINK_TRAIN } from "../shared/entry_links.js";
import { onboardingFactsOf, onboardingNextStep, type OnboardingNextStep } from "./get_onboarding_status.js";

/** Where the person stands: they hold a program, can build one now, or need the intake first. */
export type GenerateProgramState = "has_program" | "ready_to_build" | "needs_intake";

export interface GenerateProgramReply {
  state: GenerateProgramState;
  link: string;
  message: string;
}

export const GENERATE_PROGRAM_DESCRIPTION =
  "Start or continue the athlete's training program in Pelaris. Programs are built in the Pelaris app, " +
  "where the athlete can see them come together and shape them, so this tool does not build one in this " +
  "chat. It returns the link that opens Pelaris at the right place: building their program, or their " +
  "program if they already have one. If the athlete has not done their intake yet, you can ask the " +
  "intake questions here and save the answers with complete_intake first. Planning a single session or " +
  "a week here with create_planned_session is still fine.";

/** The fixed words for each state, addressed to the assistant. Positive, no ids, nothing about the person. */
export const GENERATE_PROGRAM_MESSAGES: Readonly<Record<GenerateProgramState, string>> = {
  ready_to_build:
    "Programs are built in Pelaris, where the athlete can see their program come together and shape it. " +
    "Their intake is done, so this link takes them straight to building their program. Share the link and " +
    "tell them it opens Pelaris. Please do not try to build the program in this chat. Planning a single " +
    "session or a week here is still fine.",
  needs_intake:
    "Programs are built in Pelaris. First Pelaris needs a few answers about the athlete: their goal, " +
    "experience, training days, and any injuries or health conditions. You can ask them here and save " +
    "their answers with complete_intake, then call generate_program again for their link. Or share the " +
    "link now and they can answer the same questions inside Pelaris. Either way, the program itself is " +
    "built in Pelaris.",
  has_program:
    "This athlete already has a program in Pelaris (it may be paused), so there is nothing to build. " +
    "This link opens it on Today, where they can resume it if it is paused. Planning or changing " +
    "individual sessions here is still fine.",
};

/**
 * The state is `get_onboarding_status`'s own `next_step`, renamed for this tool's three answers:
 * `complete_intake` (no program yet, intake missing), `generate_program` (intake done, no program),
 * `train_today` (a program is held, running or not).
 */
const STATE_OF_NEXT_STEP: Readonly<Record<OnboardingNextStep, GenerateProgramState>> = {
  complete_intake: "needs_intake",
  generate_program: "ready_to_build",
  train_today: "has_program",
};

export function generateProgramStateOf(
  facts: { hasCompletedOnboarding: boolean; hasProgram: boolean },
): GenerateProgramState {
  return STATE_OF_NEXT_STEP[onboardingNextStep(facts)];
}

/** The reply for a state: the link that opens Pelaris at the right place and the fixed words. */
export function buildGenerateProgramReply(state: GenerateProgramState): GenerateProgramReply {
  return {
    state,
    link: state === "has_program" ? ENTRY_LINK_TRAIN : ENTRY_LINK_PROGRAM,
    message: GENERATE_PROGRAM_MESSAGES[state],
  };
}

/** The seam the tests use; production reads the person's own profile document. */
export interface GenerateProgramDeps {
  readProfile: (profileId: string) => Promise<Record<string, unknown> | null>;
}

const DEFAULT_DEPS: GenerateProgramDeps = {
  readProfile: async (profileId) => {
    const snap = await db.collection("profiles").doc(profileId).get();
    return snap.exists ? (snap.data() as Record<string, unknown>) : null;
  },
};

/** Fixed sentences for the three ways this tool can say no. Never an error message, never an id. */
export const GENERATE_PROGRAM_ERRORS = {
  scope: "Error: training:read or training:write scope required",
  profileMissing: "Error: I could not find a Pelaris profile for this account.",
  tryAgain: "Error: I could not check your Pelaris account just now. Please try again in a moment.",
} as const;

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export function registerGenerateProgram(server: McpServer, deps: GenerateProgramDeps = DEFAULT_DEPS): void {
  server.registerTool(
    "generate_program",
    {
      title: "Start Your Program",
      description: GENERATE_PROGRAM_DESCRIPTION,
      // No arguments. A cached schema from before 22/10/2026 may still send goal, weeks or notes: the
      // validator strips them and the person still gets their link.
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: "Start Your Program" },
    },
    async () => {
      const requestId = generateRequestId();
      const start = Date.now();
      // Read before the try so the catch can name the person's pseudonym too.
      const claims = getRequestAuth();
      const log = (success: boolean, error?: string, extras?: Record<string, unknown>) =>
        logToolCall({
          requestId,
          tool: "generate_program",
          userPseudonym: claims?.sub,
          latencyMs: Date.now() - start,
          success,
          ...(error ? { error } : {}),
          ...(extras ? { extras } : {}),
        });
      try {
        if (!claims || !(hasScope(claims.scope, "training:read") || hasScope(claims.scope, "training:write"))) {
          log(false, "scope_required");
          return errorResult(GENERATE_PROGRAM_ERRORS.scope);
        }
        const profile = await deps.readProfile(claims.profile_id);
        if (profile === null) {
          log(false, "profile_not_found");
          return errorResult(GENERATE_PROGRAM_ERRORS.profileMissing);
        }
        const reply = buildGenerateProgramReply(generateProgramStateOf(onboardingFactsOf(profile)));
        log(true, undefined, { reply_state: reply.state });
        return { content: [{ type: "text" as const, text: JSON.stringify(reply, null, 2) }] };
      } catch (error) {
        // The error's name only: its message can carry a path or an id.
        log(false, "generate_program_failed", { error_name: error instanceof Error ? error.name : "unknown" });
        return errorResult(GENERATE_PROGRAM_ERRORS.tryAgain);
      }
    },
  );
}
