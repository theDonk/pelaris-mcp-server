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
    "View the full details of a workout session — exercises, sets, reps, weights, completion status, and feedback.",
    {
      sessionId: z.string().describe("The diary session document ID (e.g., session_strength_20260115_143022)"),
    },
    { readOnlyHint: true },
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

        const session = {
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
