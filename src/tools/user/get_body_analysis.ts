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

export function registerGetBodyAnalysis(server: McpServer): void {
  server.tool(
    "get_body_analysis",
    "View your latest body composition data — measurements, ratios, archetype, and changes since your last analysis.",
    {},
    { readOnlyHint: true },
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
            content: [{ type: "text" as const, text: JSON.stringify({ analysis: null, message: "No body analysis data found" }) }],
          };
        }

        const latest = biometricsSnap.docs[0].data();
        const previous = biometricsSnap.docs.length > 1 ? biometricsSnap.docs[1].data() : null;

        const analysis = {
          analyzedAt: latest.analyzedAt?.toDate?.()?.toISOString?.() || null,
          source: latest.source || null,
          confidence: latest.confidence || null,

          // Measurements
          measurements: {
            weightKg: latest.weightKg ?? null,
            waistCm: latest.waistCm ?? null,
            hipsCm: latest.hipsCm ?? null,
            shouldersCm: latest.shouldersCm ?? null,
            heightCm: latest.heightCm ?? null,
            chestCm: latest.chestCm ?? null,
            muscleMassPercent: latest.muscleMassPercent ?? null,
          },

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
