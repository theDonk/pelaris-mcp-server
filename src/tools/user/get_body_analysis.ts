/**
 * MCP Tool: get_body_analysis
 * Scope: health:read
 *
 * Returns the user's latest body analysis data from the biometrics subcollection.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { profileSubcollection } from "../../firestore-client.js";
import { scrubDocument } from "../../scrubber.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import { plainDay } from "../shared/training_truth.js";
import { ENTRY_LINK_SCAN } from "../shared/entry_links.js";

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

        const profileId = claims.profile_id;

        // Get latest biometrics (CRITICAL: use orderBy analyzedAt, not doc('baseline'))
        const biometricsSnap = await profileSubcollection(profileId, "biometrics")
          .orderBy("analyzedAt", "desc")
          .limit(2)
          .get();

        if (biometricsSnap.empty) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ analysis: null, message: "No body analysis data found", scanLink: ENTRY_LINK_SCAN }) }],
          };
        }

        const latest = biometricsSnap.docs[0].data();
        const previous = biometricsSnap.docs.length > 1 ? biometricsSnap.docs[1].data() : null;

        const bodyFat = bodyFatFields(latest.bodyFatPercent);
        const analyzedAtIso: string | null = latest.analyzedAt?.toDate?.()?.toISOString?.() || null;
        const analysis = {
          analyzedAt: analyzedAtIso,
          source: latest.source || null,
          confidence: latest.confidence || null,
          ...bodyAnalysisAsOf(analyzedAtIso, (latest.source as string | undefined) || null),

          // Measurements
          measurements: {
            weightKg: latest.weightKg ?? null,
            waistCm: latest.waistCm ?? null,
            hipsCm: latest.hipsCm ?? null,
            shouldersCm: latest.shouldersCm ?? null,
            heightCm: latest.heightCm ?? null,
            chestCm: latest.chestCm ?? null,
            muscleMassPercent: latest.muscleMassPercent ?? null,
            upperArmCm: latest.upperArmCm ?? null,
            thighCm: latest.thighCm ?? null,
            calfCm: latest.calfCm ?? null,
            bodyFatPercent: bodyFat.bodyFatPercent,
          },
          bodyFatRangePercent: bodyFat.bodyFatRangePercent,
          symmetry: bodySymmetry(latest),
          // Where to start a new scan: the connector never takes photos, the app does.
          scanLink: ENTRY_LINK_SCAN,

          // Ratios
          ratios: {
            shoulderToWaist: latest.shoulderToWaistRatio ?? null,
            waistToHip: latest.waistToHipRatio ?? null,
            waistToHeight: latest.waistToHeightRatio ?? null,
          },

          // AI assessments
          archetype: latest.archetype || null,
          assessment: latest.assessment || null,
          trainingRecommendation: latest.trainingRecommendation || null,
          areasOfFocus: latest.areasOfFocus || [],

          // Comparison to previous
          comparisonToPrevious: previous ? {
            previousAnalyzedAt: previous.analyzedAt?.toDate?.()?.toISOString?.() || null,
            changes: {
              weightKg: computeDelta(latest.weightKg, previous.weightKg),
              waistCm: computeDelta(latest.waistCm, previous.waistCm),
              hipsCm: computeDelta(latest.hipsCm, previous.hipsCm),
              shouldersCm: computeDelta(latest.shouldersCm, previous.shouldersCm),
            },
          } : null,
        };

        const result = scrubDocument(analysis as Record<string, unknown>);

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

function computeDelta(current: number | null | undefined, previous: number | null | undefined): { value: number; direction: string } | null {
  if (current == null || previous == null) return null;
  const delta = current - previous;
  return {
    value: Math.round(delta * 10) / 10,
    direction: delta > 0 ? "up" : delta < 0 ? "down" : "stable",
  };
}
