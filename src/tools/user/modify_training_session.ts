/**
 * MCP Tool: modify_training_session
 * Scope: training:write
 *
 * Reads a diary entry, applies requested modifications, and writes back.
 * Supports: volume reduction, intensity changes, exercise swaps, rescheduling.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { profileSubcollection } from "../../firestore-client.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { checkWriteRateLimit } from "../../middleware/rate-limiter.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";

export function registerModifyTrainingSession(server: McpServer): void {
  server.tool(
    "modify_training_session",
    "Modify a planned training session. Supports reducing volume, changing intensity, swapping an exercise, or rescheduling to a different date.",
    {
      sessionId: z
        .string()
        .min(1)
        .max(200)
        .describe("The diary session document ID"),
      reduceVolume: z
        .number()
        .min(0.1)
        .max(1.0)
        .optional()
        .describe("Volume multiplier (e.g., 0.5 = halve all sets/reps, 0.75 = reduce by 25%)"),
      increaseIntensity: z
        .number()
        .min(0.5)
        .max(2.0)
        .optional()
        .describe("Intensity multiplier for weights (e.g., 1.1 = increase by 10%)"),
      swapExercise: z
        .object({
          from: z.string().min(1).max(200).describe("Name of the exercise to replace"),
          to: z.string().min(1).max(200).describe("Name of the replacement exercise"),
        })
        .optional()
        .describe("Swap one exercise for another"),
      rescheduleDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
        .optional()
        .describe("New scheduled date in YYYY-MM-DD format"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
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

        // Validate at least one modification provided
        if (!params.reduceVolume && !params.increaseIntensity && !params.swapExercise && !params.rescheduleDate) {
          return {
            content: [{ type: "text" as const, text: "Error: At least one modification is required (reduceVolume, increaseIntensity, swapExercise, or rescheduleDate)" }],
            isError: true,
          };
        }

        const profileId = claims.profile_id;
        const diaryRef = profileSubcollection(profileId, "diary").doc(params.sessionId);
        const sessionDoc = await diaryRef.get();

        if (!sessionDoc.exists) {
          return {
            content: [{ type: "text" as const, text: `Session "${params.sessionId}" not found` }],
            isError: true,
          };
        }

        const sessionData = sessionDoc.data()!;

        // Don't modify completed sessions
        if (sessionData.is_completed || sessionData.status === "completed") {
          return {
            content: [{ type: "text" as const, text: "Error: Cannot modify a completed session" }],
            isError: true,
          };
        }

        const updates: Record<string, unknown> = {};
        const modifications: string[] = [];

        // Apply volume reduction
        if (params.reduceVolume != null) {
          const blocks = (sessionData.blocks || []) as Array<Record<string, unknown>>;
          const updatedBlocks = blocks.map((block) => {
            const exercises = (block.exercises || []) as Array<Record<string, unknown>>;
            return {
              ...block,
              exercises: exercises.map((ex) => {
                const sets = (ex.sets || []) as Array<Record<string, unknown>>;
                // Reduce number of sets by the multiplier (minimum 1 set)
                const targetSetCount = Math.max(1, Math.round(sets.length * params.reduceVolume!));
                const reducedSets = sets.slice(0, targetSetCount).map((s) => {
                  // Also reduce reps if applicable
                  const updated = { ...s };
                  if (typeof s.target_reps === "number") {
                    updated.target_reps = Math.max(1, Math.round((s.target_reps as number) * params.reduceVolume!));
                  }
                  return updated;
                });
                return { ...ex, sets: reducedSets };
              }),
            };
          });
          updates.blocks = updatedBlocks;
          modifications.push(`Volume reduced by ${Math.round((1 - params.reduceVolume) * 100)}%`);
        }

        // Apply intensity change
        if (params.increaseIntensity != null) {
          const blocks = ((updates.blocks as Array<Record<string, unknown>>) || sessionData.blocks || []) as Array<Record<string, unknown>>;
          const updatedBlocks = blocks.map((block) => {
            const exercises = (block.exercises || []) as Array<Record<string, unknown>>;
            return {
              ...block,
              exercises: exercises.map((ex) => {
                const sets = (ex.sets || []) as Array<Record<string, unknown>>;
                return {
                  ...ex,
                  sets: sets.map((s) => {
                    const updated = { ...s };
                    if (typeof s.target_weight_kg === "number") {
                      updated.target_weight_kg = Math.round(
                        (s.target_weight_kg as number) * params.increaseIntensity! * 10,
                      ) / 10;
                    }
                    if (typeof s.target_rpe === "number") {
                      updated.target_rpe = Math.min(10, Math.round(
                        (s.target_rpe as number) * params.increaseIntensity! * 10,
                      ) / 10);
                    }
                    return updated;
                  }),
                };
              }),
            };
          });
          updates.blocks = updatedBlocks;
          const pctChange = Math.round((params.increaseIntensity - 1) * 100);
          modifications.push(`Intensity ${pctChange >= 0 ? "increased" : "decreased"} by ${Math.abs(pctChange)}%`);
        }

        // Apply exercise swap
        if (params.swapExercise) {
          const blocks = ((updates.blocks as Array<Record<string, unknown>>) || sessionData.blocks || []) as Array<Record<string, unknown>>;
          let swapped = false;
          const updatedBlocks = blocks.map((block) => {
            const exercises = (block.exercises || []) as Array<Record<string, unknown>>;
            return {
              ...block,
              exercises: exercises.map((ex) => {
                const name = (ex.exercise_name as string || "").toLowerCase();
                if (name === params.swapExercise!.from.toLowerCase()) {
                  swapped = true;
                  return {
                    ...ex,
                    exercise_name: params.swapExercise!.to,
                    mcp_swap_note: `Swapped from "${params.swapExercise!.from}" via MCP`,
                  };
                }
                return ex;
              }),
            };
          });
          if (!swapped) {
            return {
              content: [{ type: "text" as const, text: `Exercise "${params.swapExercise.from}" not found in session` }],
              isError: true,
            };
          }
          updates.blocks = updatedBlocks;
          modifications.push(`Swapped "${params.swapExercise.from}" → "${params.swapExercise.to}"`);
        }

        // Apply reschedule
        if (params.rescheduleDate) {
          updates.scheduled_date = params.rescheduleDate;
          modifications.push(`Rescheduled to ${params.rescheduleDate}`);
        }

        // Add modification metadata
        updates.mcp_modified_at = new Date().toISOString();
        updates.mcp_modifications = modifications;
        updates.adaptation_applied = true;

        await diaryRef.update(updates);

        const result = scrubDocument({
          sessionId: params.sessionId,
          title: sessionData.title,
          modifications,
          updatedFields: Object.keys(updates).filter((k) => !k.startsWith("mcp_")),
          message: `Session modified successfully: ${modifications.join("; ")}`,
        });

        logToolCall({
          requestId,
          tool: "modify_training_session",
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
          tool: "modify_training_session",
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
