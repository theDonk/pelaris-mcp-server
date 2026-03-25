/**
 * MCP Tool: check_in
 * Scope: training:write
 *
 * Records a daily readiness check-in. Writes to the checkins subcollection
 * with a deterministic document ID to prevent duplicates for the same day.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { profileSubcollection } from "../../firestore-client.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { checkWriteRateLimit } from "../../middleware/rate-limiter.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";

const VALID_MOODS = [
  "great", "good", "okay", "tired", "stressed", "sore",
  "motivated", "flat", "anxious", "energetic", "recovered",
] as const;

export function registerCheckIn(server: McpServer): void {
  server.tool(
    "Daily Check-In",
    "Log how you're feeling today — readiness, soreness, sleep, and mood. Your coach uses this to adapt upcoming sessions.",
    {
      readiness: z
        .number()
        .int()
        .min(1)
        .max(10)
        .describe("Overall readiness to train (1 = very low, 10 = peak)"),
      soreness: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("Muscle soreness level (1 = none, 10 = severe)"),
      sleepQuality: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("Sleep quality (1 = terrible, 10 = excellent)"),
      mood: z
        .enum(VALID_MOODS)
        .optional()
        .describe("Current mood/energy state"),
      notes: z
        .string()
        .max(1000)
        .optional()
        .describe("Freeform notes about how you're feeling"),
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

        const profileId = claims.profile_id;
        const today = new Date().toISOString().split("T")[0];
        const docId = `checkin_daily_${today.replace(/-/g, "")}`;
        const checkinsCol = profileSubcollection(profileId, "checkins");
        const docRef = checkinsCol.doc(docId);

        const now = new Date();
        const periodStart = new Date(`${today}T00:00:00.000Z`);
        const periodEnd = new Date(`${today}T23:59:59.999Z`);

        const checkinData: Record<string, unknown> = {
          id: docId,
          type: "daily",
          period_start: periodStart,
          period_end: periodEnd,
          raw_text: params.notes || "",
          parsed_metrics: {
            readiness: params.readiness,
            ...(params.soreness != null ? { soreness: params.soreness } : {}),
            ...(params.sleepQuality != null ? { sleep_quality: params.sleepQuality } : {}),
            ...(params.mood ? { mood: params.mood } : {}),
          },
          created_at: now,
          updated_at: now,
          source: "mcp",
        };

        // Use set with merge to handle idempotent re-check-ins on the same day
        await docRef.set(checkinData, { merge: true });

        // Generate coaching note for low readiness
        let coachingNote: string | null = null;
        if (params.readiness <= 3) {
          coachingNote = "Readiness is very low today. Consider active recovery, mobility work, or a rest day. Pushing through fatigue accumulates debt.";
        } else if (params.readiness <= 5) {
          coachingNote = "Readiness is below average. Consider reducing intensity or volume today. Listen to your body.";
        } else if (params.soreness != null && params.soreness >= 8) {
          coachingNote = "High soreness detected. Focus on the muscle groups that aren't affected, or do light movement and stretching.";
        } else if (params.sleepQuality != null && params.sleepQuality <= 3) {
          coachingNote = "Poor sleep affects recovery and performance. Consider a lighter session today and prioritize sleep tonight.";
        }

        const result = scrubDocument({
          checkinId: docId,
          date: today,
          readiness: params.readiness,
          soreness: params.soreness ?? null,
          sleepQuality: params.sleepQuality ?? null,
          mood: params.mood ?? null,
          coachingNote,
          status: "recorded",
          message: `Check-in recorded for ${today}: readiness ${params.readiness}/10${coachingNote ? " — coach note attached" : ""}`,
        });

        logToolCall({
          requestId,
          tool: "check_in",
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
          tool: "check_in",
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
