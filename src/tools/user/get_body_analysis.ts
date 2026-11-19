/**
 * MCP Tool: get_body_analysis
 * Scope: health:read
 *
 * Returns the athlete's latest body analysis. The numbers come from the server's core
 * get_body_analysis over the core bridge (one producer, shared with the in-app coach): the latest
 * scan merged with newer weigh-ins, and the athlete's profile weight and height when no scan or
 * weigh-in has them. This wrapper keeps scope, the scan link, the "as of" line and the scrub, and
 * maps the core result to this tool's long-standing output shape.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { scrubDocument } from "../../scrubber.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import { plainDay } from "../shared/training_truth.js";
import { mintSignedEntryLink } from "../shared/entry_links.js";
import { callCoreBridge } from "../shared/bridge_client.js";
import { bridgeFailureResponse } from "../shared/core_adapter.js";

/**
 * 1.4.1 D2 (connector truth): the "as of" line. A body analysis is a snapshot from the day it was
 * made; a weight logged since (a benchmark, a weigh-in) can be newer. Without the date an assistant
 * set a March scan beside an October weight as if both were current. Pure (exported for tests).
 */
export function bodyAnalysisAsOf(analyzedAtIso: string | null, source: string | null): { asOf: string | null; asOfNote: string } {
  const day = plainDay(analyzedAtIso);
  const from = source ? ` (source: ${source})` : "";
  return day != null
    ? {
        asOf: analyzedAtIso ? analyzedAtIso.slice(0, 10) : null,
        asOfNote: `Measured on ${day}${from}. A weight or benchmark logged since then may be newer than these measurements.`,
      }
    : { asOf: null, asOfNote: `The date of this analysis is not recorded${from}.` };
}

function ratio2dp(num: unknown, den: unknown): number | null {
  if (typeof num !== "number" || typeof den !== "number") return null;
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return null;
  return Math.round((num / den) * 100) / 100;
}

/** v2.2 symmetry ratios from the measured limbs (null when either side is missing). Pure (exported for tests). */
export function bodySymmetry(latest: Record<string, unknown>): Record<string, number | null> | null {
  const out = {
    upperToLowerRatio: ratio2dp(latest.shouldersCm, latest.hipsCm),
    armToWaistRatio: ratio2dp(latest.upperArmCm, latest.waistCm),
    thighToWaistRatio: ratio2dp(latest.thighCm, latest.waistCm),
    calfToThighRatio: ratio2dp(latest.calfCm, latest.thighCm),
  };
  return Object.values(out).every((v) => v === null) ? null : out;
}

/** A body fat number, or the middle and range of an estimate stored as a map. Pure (exported for tests). */
export function bodyFatFields(raw: unknown): { bodyFatPercent: number | null; bodyFatRangePercent: { low: number; high: number } | null } {
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  if (num(raw) !== null) return { bodyFatPercent: num(raw), bodyFatRangePercent: null };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const m = raw as Record<string, unknown>;
    const low = num(m.low);
    const high = num(m.high);
    return { bodyFatPercent: num(m.mid), bodyFatRangePercent: low !== null && high !== null ? { low, high } : null };
  }
  return { bodyFatPercent: null, bodyFatRangePercent: null };
}

const MEASUREMENT_FIELDS = [
  "weightKg", "waistCm", "hipsCm", "shouldersCm", "heightCm", "chestCm",
  "muscleMassPercent", "upperArmCm", "thighCm", "calfCm", "bodyFatPercent",
] as const;

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Map the core get_body_analysis result to this tool's output. Field by field on purpose: only the
 * fields this tool has always returned cross over, nothing else the core result may carry. The
 * merge and fallback (scan, newer weigh-ins, profile weight and height) and the changes since the
 * previous scan are the core's; this only reshapes. Pure (exported for tests).
 */
export function bodyAnalysisFromCore(core: Record<string, unknown>, scanLink: string): Record<string, unknown> {
  const analyzedAt = typeof core.analyzedAt === "string" ? core.analyzedAt : null;
  const source = typeof core.source === "string" && core.source ? core.source : null;
  const m = obj(core.measurements) ?? {};
  const measurements: Record<string, unknown> = {};
  for (const f of MEASUREMENT_FIELDS) measurements[f] = m[f] ?? null;
  const ratios = obj(core.ratios) ?? {};
  const symmetry = obj(core.symmetry);
  const comparison = obj(core.comparisonToPrevious);
  const changes = obj(comparison?.changes) ?? {};
  return {
    analyzedAt,
    source,
    confidence: core.confidence || null,
    ...bodyAnalysisAsOf(analyzedAt, source),
    measurements,
    bodyFatRangePercent: obj(core.bodyFatRangePercent) ?? null,
    symmetry: symmetry
      ? {
          upperToLowerRatio: symmetry.upperToLowerRatio ?? null,
          armToWaistRatio: symmetry.armToWaistRatio ?? null,
          thighToWaistRatio: symmetry.thighToWaistRatio ?? null,
          calfToThighRatio: symmetry.calfToThighRatio ?? null,
        }
      : null,
    // Where to start a new scan: the connector never takes photos, the app does.
    scanLink,
    ratios: {
      shoulderToWaist: ratios.shoulderToWaist ?? null,
      waistToHip: ratios.waistToHip ?? null,
      waistToHeight: ratios.waistToHeight ?? null,
    },
    archetype: core.archetype || null,
    assessment: core.assessment || null,
    trainingRecommendation: core.trainingRecommendation || null,
    areasOfFocus: Array.isArray(core.areasOfFocus) ? core.areasOfFocus : [],
    comparisonToPrevious: comparison
      ? {
          previousAnalyzedAt: comparison.previousAnalyzedAt ?? null,
          changes: {
            weightKg: changes.weightKg ?? null,
            waistCm: changes.waistCm ?? null,
            hipsCm: changes.hipsCm ?? null,
            shouldersCm: changes.shouldersCm ?? null,
          },
        }
      : null,
  };
}

export function registerGetBodyAnalysis(server: McpServer): void {
  server.registerTool(
    "get_body_analysis",
    {
      title: "Get Body Analysis",
      description: "View your latest body composition data — measurements (including limbs and body fat), ratios, symmetry, archetype, and changes since your last analysis. Includes a link to start a new Body scan in Pelaris.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, title: "Get Body Analysis" },
    },
    async () => {
      const requestId = generateRequestId();
      const start = Date.now();

      try {
        const claims = getRequestAuth();
        if (!claims || !hasScope(claims.scope, "health:read")) {
          return {
            content: [{ type: "text" as const, text: "Error: health:read scope required" }],
            isError: true,
          };
        }

        const bridged = await callCoreBridge("get_body_analysis", claims.profile_id, {});

        // The core answers null when there is no scan, weigh-in or profile measurement at all.
        if (bridged.ok && bridged.result == null) {
          logToolCall({ requestId, tool: "get_body_analysis", userPseudonym: claims.sub, latencyMs: Date.now() - start, success: true });
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ analysis: null, message: "No body analysis data found", scanLink: await mintSignedEntryLink("scan", claims) }) }],
          };
        }

        const failure = bridgeFailureResponse(bridged, "reading body analysis");
        if (failure) {
          logToolCall({
            requestId,
            tool: "get_body_analysis",
            userPseudonym: claims.sub,
            latencyMs: Date.now() - start,
            success: false,
            error: bridged.error ?? "unknown error",
          });
          return failure;
        }

        const analysis = bodyAnalysisFromCore(bridged.result as Record<string, unknown>, await mintSignedEntryLink("scan", claims));
        const result = scrubDocument(analysis);

        logToolCall({
          requestId,
          tool: "get_body_analysis",
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
          tool: "get_body_analysis",
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
