/**
 * MCP Tool: swap_exercise
 * Scope: training:write
 *
 * Finds exercise alternatives based on muscle group / movement pattern.
 * Can suggest 3 alternatives or auto-apply a swap.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { profileSubcollection } from "../../firestore-client.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { checkWriteRateLimit } from "../../middleware/rate-limiter.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";

/**
 * Static exercise alternatives grouped by movement pattern.
 * Provides reasonable swap suggestions without needing an AI call.
 */
const EXERCISE_ALTERNATIVES: Record<string, Array<{ name: string; rationale: string }>> = {
  // Horizontal push
  "bench press": [
    { name: "Dumbbell Bench Press", rationale: "Same movement pattern, allows independent arm work" },
    { name: "Push-Ups", rationale: "Bodyweight alternative, no equipment needed" },
    { name: "Machine Chest Press", rationale: "Guided motion, easier on joints" },
  ],
  "push-ups": [
    { name: "Bench Press", rationale: "Loaded horizontal push, progressive overload" },
    { name: "Dumbbell Floor Press", rationale: "Reduced range of motion, shoulder-friendly" },
    { name: "Incline Push-Ups", rationale: "Easier progression, same pattern" },
  ],
  // Horizontal pull
  "barbell row": [
    { name: "Dumbbell Row", rationale: "Unilateral, easier on lower back" },
    { name: "Cable Row", rationale: "Constant tension, adjustable angle" },
    { name: "Chest-Supported Row", rationale: "Removes lower back strain" },
  ],
  // Vertical push
  "overhead press": [
    { name: "Dumbbell Shoulder Press", rationale: "Independent arms, natural movement arc" },
    { name: "Landmine Press", rationale: "Shoulder-friendly angle" },
    { name: "Machine Shoulder Press", rationale: "Guided motion, joint protection" },
  ],
  // Vertical pull
  "pull-ups": [
    { name: "Lat Pulldown", rationale: "Adjustable resistance, same muscle groups" },
    { name: "Assisted Pull-Ups", rationale: "Same movement with band or machine assist" },
    { name: "Inverted Rows", rationale: "Bodyweight alternative, easier progression" },
  ],
  "lat pulldown": [
    { name: "Pull-Ups", rationale: "Bodyweight vertical pull, gold standard" },
    { name: "Cable Pullover", rationale: "Isolates lats, different angle" },
    { name: "Straight-Arm Pulldown", rationale: "Lat isolation without bicep involvement" },
  ],
  // Squat pattern
  "barbell squat": [
    { name: "Goblet Squat", rationale: "Front-loaded, easier form" },
    { name: "Leg Press", rationale: "Machine-guided, reduces spinal load" },
    { name: "Bulgarian Split Squat", rationale: "Unilateral, addresses imbalances" },
  ],
  "squat": [
    { name: "Goblet Squat", rationale: "Front-loaded, easier form" },
    { name: "Leg Press", rationale: "Machine-guided, reduces spinal load" },
    { name: "Bulgarian Split Squat", rationale: "Unilateral, addresses imbalances" },
  ],
  // Hinge pattern
  "deadlift": [
    { name: "Romanian Deadlift", rationale: "Hamstring focus, less spinal load" },
    { name: "Trap Bar Deadlift", rationale: "More upright posture, knee-friendly" },
    { name: "Hip Thrust", rationale: "Glute focus, no spinal compression" },
  ],
  "romanian deadlift": [
    { name: "Good Morning", rationale: "Similar hinge, barbell variation" },
    { name: "Single-Leg RDL", rationale: "Unilateral balance challenge" },
    { name: "Cable Pull-Through", rationale: "Constant tension, easy on back" },
  ],
  // Cardio
  "running": [
    { name: "Cycling", rationale: "Low-impact cardio alternative" },
    { name: "Rowing", rationale: "Full-body, low impact on joints" },
    { name: "Elliptical", rationale: "Running motion without ground impact" },
  ],
  "swimming": [
    { name: "Rowing", rationale: "Full-body, upper-body emphasis" },
    { name: "Cycling", rationale: "Low-impact cardio alternative" },
    { name: "Pool Running", rationale: "Water-based, no shoulder strain" },
  ],
};

/**
 * Find alternatives for an exercise by checking known patterns.
 * Falls back to generic suggestions if no exact match.
 */
function findAlternatives(
  exerciseName: string,
  reason?: string,
): Array<{ name: string; rationale: string }> {
  const normalised = exerciseName.toLowerCase().trim();

  // Direct match
  if (EXERCISE_ALTERNATIVES[normalised]) {
    return EXERCISE_ALTERNATIVES[normalised];
  }

  // Partial match — check if exercise name contains a known pattern
  for (const [key, alts] of Object.entries(EXERCISE_ALTERNATIVES)) {
    if (normalised.includes(key) || key.includes(normalised)) {
      return alts;
    }
  }

  // Generic fallback based on reason
  if (reason === "equipment") {
    return [
      { name: "Bodyweight variation", rationale: "No equipment needed" },
      { name: "Resistance band variation", rationale: "Portable equipment substitute" },
      { name: "Dumbbell variation", rationale: "Common equipment substitute" },
    ];
  }

  if (reason === "injury") {
    return [
      { name: "Reduced range-of-motion variation", rationale: "Less stress on injured area" },
      { name: "Machine variation", rationale: "Guided motion, protects joints" },
      { name: "Isometric hold variation", rationale: "Strengthens without dynamic movement" },
    ];
  }

  return [
    { name: "Similar movement pattern exercise", rationale: "Consult your coach for specific alternatives" },
    { name: "Machine variation", rationale: "Guided motion alternative" },
    { name: "Dumbbell variation", rationale: "Free weight alternative" },
  ];
}

export function registerSwapExercise(server: McpServer): void {
  server.tool(
    "swap_exercise",
    "Find alternatives for an exercise. Returns 3 suggestions with rationale. If sessionId is provided, can verify the exercise exists and optionally auto-apply the swap.",
    {
      sessionId: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("The diary session document ID (optional — omit for general alternatives)"),
      exerciseName: z
        .string()
        .min(1)
        .max(200)
        .describe("Name of the exercise to swap out"),
      reason: z
        .enum(["equipment", "injury", "preference"])
        .optional()
        .describe("Reason for the swap — helps find better alternatives"),
      autoApply: z
        .boolean()
        .optional()
        .describe("If true, automatically apply the first alternative to the session"),
    },
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

        // Write rate limit (even for suggestions — prevents abuse)
        const rateLimitError = checkWriteRateLimit(claims.sub);
        if (rateLimitError) {
          return {
            content: [{ type: "text" as const, text: `Error: ${rateLimitError}` }],
            isError: true,
          };
        }

        const profileId = claims.profile_id;

        // Find alternatives (works with or without a session)
        const alternatives = findAlternatives(params.exerciseName, params.reason);

        // If no sessionId provided, return general alternatives without session context
        if (!params.sessionId) {
          const result = scrubDocument({
            action: "suggestions",
            original: params.exerciseName,
            reason: params.reason || "preference",
            alternatives: alternatives.map((alt, i) => ({
              rank: i + 1,
              name: alt.name,
              rationale: alt.rationale,
            })),
            message: `Found ${alternatives.length} alternatives for "${params.exerciseName}". Provide a sessionId to apply a swap to a specific session.`,
          });

          logToolCall({
            requestId,
            tool: "swap_exercise",
            userPseudonym: claims.sub,
            latencyMs: Date.now() - start,
            success: true,
          });

          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        // Session-specific flow
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
            content: [{ type: "text" as const, text: "Error: Cannot swap exercises in a completed session" }],
            isError: true,
          };
        }

        // Verify exercise exists in the session
        const blocks = (sessionData.blocks || []) as Array<Record<string, unknown>>;
        let exerciseFound = false;
        for (const block of blocks) {
          const exercises = (block.exercises || []) as Array<Record<string, unknown>>;
          for (const ex of exercises) {
            if ((ex.exercise_name as string || "").toLowerCase() === params.exerciseName.toLowerCase()) {
              exerciseFound = true;
              break;
            }
          }
          if (exerciseFound) break;
        }

        if (!exerciseFound) {
          return {
            content: [{ type: "text" as const, text: `Exercise "${params.exerciseName}" not found in session` }],
            isError: true,
          };
        }

        // Auto-apply if requested
        if (params.autoApply && alternatives.length > 0) {
          const replacement = alternatives[0].name;
          const updatedBlocks = blocks.map((block) => {
            const exercises = (block.exercises || []) as Array<Record<string, unknown>>;
            return {
              ...block,
              exercises: exercises.map((ex) => {
                if ((ex.exercise_name as string || "").toLowerCase() === params.exerciseName.toLowerCase()) {
                  return {
                    ...ex,
                    exercise_name: replacement,
                    mcp_swap_note: `Swapped from "${params.exerciseName}" (reason: ${params.reason || "preference"})`,
                  };
                }
                return ex;
              }),
            };
          });

          await diaryRef.update({
            blocks: updatedBlocks,
            mcp_modified_at: new Date().toISOString(),
          });

          const result = scrubDocument({
            sessionId: params.sessionId,
            action: "swapped",
            original: params.exerciseName,
            replacement,
            rationale: alternatives[0].rationale,
            reason: params.reason || "preference",
            message: `Swapped "${params.exerciseName}" → "${replacement}": ${alternatives[0].rationale}`,
          });

          logToolCall({
            requestId,
            tool: "swap_exercise",
            userPseudonym: claims.sub,
            latencyMs: Date.now() - start,
            success: true,
          });

          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        // Return suggestions without applying
        const result = scrubDocument({
          sessionId: params.sessionId,
          action: "suggestions",
          original: params.exerciseName,
          reason: params.reason || "preference",
          alternatives: alternatives.map((alt, i) => ({
            rank: i + 1,
            name: alt.name,
            rationale: alt.rationale,
          })),
          message: `Found ${alternatives.length} alternatives for "${params.exerciseName}". Use autoApply: true to apply the top suggestion.`,
        });

        logToolCall({
          requestId,
          tool: "swap_exercise",
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
          tool: "swap_exercise",
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
