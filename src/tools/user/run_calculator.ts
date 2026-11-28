/**
 * MCP Tool: run_calculator
 * Scope: training:read
 *
 * Runs one of Pelaris's sports science calculators through the core
 * `run_science_calculator` tool over the coreToolsBridge. Wrapper only: the
 * maths, the catalogue and the save rule all live on the Pelaris server. This
 * file holds the calculator ids (for the input enum) and nothing else about them.
 *
 * Running and reading a result is free for every athlete. On Pelaris Ocean and
 * Pelaris Horizon the server also saves the result to the athlete's benchmarks;
 * otherwise it answers `saved: false` with a `saveDenied.message`, and this tool
 * adds a link into Pelaris's calculators.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import { callCoreBridge } from "../shared/bridge_client.js";
import { bridgeFailureResponse, unwrapBridgeResult } from "../shared/core_adapter.js";
import { mintSignedEntryLink, plainEntryLink, type HandoffRoute } from "../shared/entry_links.js";

/** The calculator ids, in the server catalogue's order. Ids only: the server owns everything else. */
export const CALCULATOR_IDS = [
  "projected_1rm_rir",
  "race_predictor_riegel",
  "vo2max_vdot_friend_hunt",
  "body_ratios_archetype_mapper",
  "concurrent_training_scheduler",
  "return_to_training_ramp",
  "sweat_rate_sodium_fuel",
  "protein_leucine_sleep_anchor",
  "deload_readiness_6signal",
  "plyo_foot_contacts_cns",
  "swim_to_gym_dryland_scaler",
  "team_sport_match_day_microcycle",
  "hyrox_station_split_compromised_run",
  "workout_csv_analyser",
  "training_split_selector",
  "zone2_heart_rate_zones",
  "mas_conditioning_grid",
  "vertical_jump_rsi_power",
  "ffmi_muscular_potential",
  "tape_rfm_body_fat",
] as const;

export type CalculatorId = (typeof CALCULATOR_IDS)[number];

/** The Pelaris screen a not-saved result links to. */
export const CALCULATOR_LINK_ROUTE: HandoffRoute = "calculators";

export const RUN_CALCULATOR_DESCRIPTION =
  "Run one of Pelaris's 20 sports science calculators (1RM and RIR, race predictor, VO2max, " +
  "heart rate zones, sweat rate and fuelling, deload readiness, body fat and more), each " +
  "with its published source. Use it for training numbers questions: Pelaris does the maths. " +
  "It is free to run for every athlete. Inputs take the athlete's real values; any input " +
  "left out uses the calculator's built-in starting value, and the result's inputs show " +
  "exactly what was used. On Pelaris Ocean and Pelaris Horizon the result is also saved to " +
  "the athlete's Pelaris benchmarks. When saved is false, the result also carries a short " +
  "message and a link about saving.";

export const runCalculatorIdField = z
  .enum(CALCULATOR_IDS)
  .describe("Which calculator to run, e.g. 'zone2_heart_rate_zones' or 'projected_1rm_rir'.");

export const runCalculatorInputsField = z
  .record(z.string(), z.union([z.number(), z.string(), z.boolean()]))
  .default({})
  .describe(
    "The calculator's inputs by name, in metric units, e.g. { weightKg: 100, reps: 5, rir: 2 }. " +
      "Inputs left out use the calculator's starting values.",
  );

export interface RunCalculatorParams {
  calculatorId: CalculatorId;
  inputs?: Record<string, number | string | boolean>;
}

/** The bridge input for one call: the id and the inputs, nothing else. */
/**
 * The bridge input. A connection without `health:write` (the scope `record_benchmark` needs)
 * tells the server not to save: the athlete still gets the answer.
 */
export function toBridgeInput(params: RunCalculatorParams, canSave = true): Record<string, unknown> {
  return { calculatorId: params.calculatorId, inputs: params.inputs ?? {}, ...(canSave ? {} : { saveAllowed: false }) };
}

/** True when the server ran the calculator but did not save it on the athlete's plan. */
export function isSaveDenied(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as { saved?: unknown; saveDenied?: unknown };
  return r.saved === false && !!r.saveDenied && typeof r.saveDenied === "object";
}

/**
 * The reply: the server's result, plus a link into Pelaris when the save was not
 * part of the athlete's plan. The server's `saveDenied.message` stays the words to say.
 */
export function buildRunCalculatorReply(result: unknown, link?: string): Record<string, unknown> {
  const base = (result && typeof result === "object" ? result : { result }) as Record<string, unknown>;
  if (!isSaveDenied(base)) return base;
  const saveDenied = base.saveDenied as Record<string, unknown>;
  return {
    ...base,
    saveDenied: { ...saveDenied, link: link ?? plainEntryLink(CALCULATOR_LINK_ROUTE) },
  };
}

export function registerRunCalculator(server: McpServer): void {
  server.registerTool(
    "run_calculator",
    {
      title: "Run a Science Calculator",
      description: RUN_CALCULATOR_DESCRIPTION,
      inputSchema: {
        calculatorId: runCalculatorIdField,
        inputs: runCalculatorInputsField,
      },
      // Not read-only: on a plan that includes saving, the result is saved to the athlete's benchmarks.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        title: "Run a Science Calculator",
      },
    },
    async (params: RunCalculatorParams) => {
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

        const bridged = await callCoreBridge(
          "run_science_calculator",
          claims.profile_id,
          toBridgeInput(params, hasScope(claims.scope, "health:write")),
        );

        const failure = bridgeFailureResponse(bridged, "running the calculator");
        if (failure) {
          logToolCall({
            requestId,
            tool: "run_calculator",
            userPseudonym: claims.sub,
            latencyMs: Date.now() - start,
            success: false,
            error: bridged.error ?? "unknown error",
          });
          return failure;
        }

        const result = scrubDocument(unwrapBridgeResult(bridged));
        const link = isSaveDenied(result) ? await mintSignedEntryLink(CALCULATOR_LINK_ROUTE, claims) : undefined;
        logToolCall({
          requestId,
          tool: "run_calculator",
          userPseudonym: claims.sub,
          latencyMs: Date.now() - start,
          success: true,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(buildRunCalculatorReply(result, link), null, 2) }],
        };
      } catch (error) {
        logToolCall({
          requestId,
          tool: "run_calculator",
          latencyMs: Date.now() - start,
          success: false,
          error: (error as Error).message,
        });
        return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
      }
    },
  );
}
