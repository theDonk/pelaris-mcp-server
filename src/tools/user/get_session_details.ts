/**
 * MCP Tool: get_session_details
 * Scope: training:read
 *
 * Returns detailed session data including exercises, sets, reps, weights, and feedback.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { profileSubcollection } from "../../firestore-client.js";
import { scrubDocument } from "../../scrubber.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { logToolCall, generateRequestId } from "../../logger.js";

export function registerGetSessionDetails(server: McpServer): void {
  server.tool(
    "get_session_details",
    "View the full details of a workout session — exercises, sets, reps, weights, completion status, feedback, and imported device metrics (distance, pace, heart rate, cadence, power, elevation, energy) from Strava/Garmin/Wahoo/Polar when available.",
    {
      sessionId: z.string().describe("The diary session document ID (e.g., session_strength_20260115_143022)"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ sessionId }) => {
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
        const sessionDoc = await profileSubcollection(profileId, "diary").doc(sessionId).get();

        if (!sessionDoc.exists) {
          return {
            content: [{ type: "text" as const, text: `Session "${sessionId}" not found` }],
            isError: true,
          };
        }

        const d = sessionDoc.data()!;

        // Extract exercise summaries from blocks
        const blocks = (d.blocks || []) as Array<Record<string, unknown>>;
        const exerciseSummaries = blocks.map((block) => {
          const exercises = (block.exercises || []) as Array<Record<string, unknown>>;
          return {
            blockType: block.type,
            semanticType: block.semantic_type || null,
            exercises: exercises.map((ex) => {
              const sets = (ex.sets || []) as Array<Record<string, unknown>>;
              return {
                exerciseName: ex.exercise_name,
                exerciseId: ex.exercise_id,
                sets: sets.map((s) => {
                  if (s.type === "strength") {
                    return {
                      type: "strength",
                      targetWeightKg: s.target_weight_kg ?? null,
                      targetReps: s.target_reps ?? null,
                      targetRpe: s.target_rpe ?? null,
                      actualWeightKg: s.actual_weight_kg ?? null,
                      actualReps: s.actual_reps ?? null,
                      actualRpe: s.actual_rpe ?? null,
                      isCompleted: s.isCompleted || false,
                    };
                  } else if (s.type === "cardio") {
                    return {
                      type: "cardio",
                      targetDistanceMeters: s.target_distance_meters ?? null,
                      targetDurationSec: s.target_duration_sec ?? null,
                      actualDistanceMeters: s.actual_distance_meters ?? null,
                      actualDurationSec: s.actual_duration_sec ?? null,
                      isCompleted: s.isCompleted || false,
                    };
                  } else {
                    return {
                      type: s.type || "unknown",
                      targetDurationSec: s.target_duration_sec ?? null,
                      actualDurationSec: s.actual_duration_sec ?? null,
                      isCompleted: s.isCompleted || false,
                    };
                  }
                }),
              };
            }),
          };
        });

        // Build imported metrics from Strava/Garmin/etc. when available
        const rawActuals = d.imported_actuals as Record<string, unknown> | undefined;
        const importedMetrics = rawActuals ? buildImportedMetrics(rawActuals) : undefined;

        const session: Record<string, unknown> = {
          sessionId: sessionDoc.id,
          title: d.title,
          scheduledDate: d.scheduled_date,
          status: d.status || (d.is_completed ? "completed" : "planned"),
          sessionType: d.session_type || null,
          sessionFocus: d.session_focus || null,
          dataQuality: d.data_quality || null,
          isHybrid: d.is_hybrid || false,
          phaseFocus: d.phase_focus || null,
          adaptationApplied: d.adaptation_applied || false,
          coachNote: d.coach_note || null,
          feedback: d.feedback ? {
            rpe: d.feedback.rpe,
            note: d.feedback.note,
            tags: d.feedback.tags || [],
            injury: d.feedback.injury || null,
          } : null,
          blocks: exerciseSummaries,
        };

        // Include completion metadata when present
        if (d.completed_via) session.completedVia = d.completed_via;
        if (d.external_url) session.externalUrl = d.external_url;
        if (d.completed_at) session.completedAt = d.completed_at.toDate?.() ?? d.completed_at;
        if (d.pool_length) session.poolLength = d.pool_length;
        if (d.environment) session.environment = d.environment;

        // Attach imported device/platform metrics (Strava, Garmin, Wahoo, Polar, etc.)
        if (importedMetrics) session.importedMetrics = importedMetrics;

        const result = scrubDocument(session as Record<string, unknown>);

        logToolCall({
          requestId,
          tool: "get_session_details",
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
          tool: "get_session_details",
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

/**
 * Transforms raw imported_actuals from Firestore into a clean, AI-readable
 * metrics object. Null/missing values are omitted entirely.
 *
 * Covers data from Strava, Garmin, Wahoo, Polar, and other integrations
 * that write to the imported_actuals map on diary documents.
 */
function buildImportedMetrics(raw: Record<string, unknown>): Record<string, unknown> | null {
  const metrics: Record<string, unknown> = {};

  // Duration
  if (raw.elapsedSeconds != null) metrics.elapsedTimeSec = raw.elapsedSeconds;
  if (raw.movingSeconds != null) metrics.movingTimeSec = raw.movingSeconds;

  // Distance
  if (raw.distanceMeters != null) {
    metrics.distanceMeters = raw.distanceMeters;
    const distKm = Number(raw.distanceMeters) / 1000;
    if (!isNaN(distKm) && distKm > 0) {
      metrics.distanceKm = Math.round(distKm * 100) / 100;
    }
  }

  // Heart rate
  if (raw.averageHeartrate != null) metrics.avgHeartrateBpm = raw.averageHeartrate;
  if (raw.maxHeartrate != null) metrics.maxHeartrateBpm = raw.maxHeartrate;

  // Speed (stored as m/s, also provide km/h and pace)
  if (raw.averageSpeedMps != null) {
    metrics.avgSpeedMps = raw.averageSpeedMps;
    const avgKmh = Number(raw.averageSpeedMps) * 3.6;
    if (!isNaN(avgKmh) && avgKmh > 0) {
      metrics.avgSpeedKmh = Math.round(avgKmh * 100) / 100;
      // Pace in min/km (useful for running/swimming)
      const paceMinPerKm = 60 / avgKmh;
      const paceMin = Math.floor(paceMinPerKm);
      const paceSec = Math.round((paceMinPerKm - paceMin) * 60);
      metrics.avgPaceMinPerKm = `${paceMin}:${paceSec.toString().padStart(2, "0")}`;
    }
  }
  if (raw.maxSpeedMps != null) {
    metrics.maxSpeedMps = raw.maxSpeedMps;
    const maxKmh = Number(raw.maxSpeedMps) * 3.6;
    if (!isNaN(maxKmh) && maxKmh > 0) {
      metrics.maxSpeedKmh = Math.round(maxKmh * 100) / 100;
    }
  }

  // Cadence
  if (raw.averageCadence != null) metrics.avgCadence = raw.averageCadence;

  // Power
  if (raw.averageWatts != null) metrics.avgPowerWatts = raw.averageWatts;
  if (raw.weightedAverageWatts != null) metrics.normalizedPowerWatts = raw.weightedAverageWatts;

  // Elevation
  if (raw.elevationGainMeters != null) metrics.elevationGainMeters = raw.elevationGainMeters;

  // Energy
  if (raw.kilojoules != null) {
    metrics.energyKj = raw.kilojoules;
    const kcal = Number(raw.kilojoules) / 4.184;
    if (!isNaN(kcal) && kcal > 0) {
      metrics.estimatedCalories = Math.round(kcal);
    }
  }

  // Strava-specific
  if (raw.sufferScore != null) metrics.sufferScore = raw.sufferScore;

  // Only return if we have at least one metric
  return Object.keys(metrics).length > 0 ? metrics : null;
}
