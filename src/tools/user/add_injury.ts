/**
 * MCP Tool: add_injury
 * Scope: health:write
 *
 * Records an injury on the user's profile with severity, affected area,
 * and optional notes about affected exercises. Returns a coaching note
 * about how training will adapt.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "../../firestore-client.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { checkWriteRateLimit } from "../../middleware/rate-limiter.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import { FieldValue } from "firebase-admin/firestore";

const VALID_BODY_PARTS = [
  "shoulder", "neck", "upper_back", "lower_back", "chest",
  "bicep", "tricep", "forearm", "wrist", "hand",
  "hip", "glute", "quad", "hamstring", "knee",
  "calf", "ankle", "foot", "shin", "groin",
  "elbow", "core", "general",
] as const;

const SEVERITY_LEVELS = ["mild", "moderate", "severe"] as const;

/** Generate coaching note based on severity and body part. */
function generateCoachingNote(bodyPart: string, severity: string): string {
  const partLabel = bodyPart.replace("_", " ");

  switch (severity) {
    case "severe":
      return `Noted: severe ${partLabel} injury. All exercises involving the ${partLabel} will be removed or replaced in upcoming sessions. Please consult a medical professional before resuming training. Your plan will focus on unaffected areas in the meantime.`;
    case "moderate":
      return `Noted: moderate ${partLabel} injury. Exercises loading the ${partLabel} will be reduced in intensity and volume. Alternative movements will be suggested where possible. Monitor for any worsening.`;
    case "mild":
      return `Noted: mild ${partLabel} discomfort. Training will continue with modifications — lighter loads and reduced range of motion for exercises involving the ${partLabel}. Flag any increase in pain.`;
    default:
      return `Noted: ${partLabel} injury recorded. Training will be adjusted accordingly.`;
  }
}

export function registerAddInjury(server: McpServer): void {
  server.tool(
    "add_injury",
    "Record an injury or pain point. Training will automatically adapt based on severity. Returns a coaching note about how your plan will adjust.",
    {
      bodyPart: z
        .enum(VALID_BODY_PARTS)
        .describe("Body part affected by the injury"),
      severity: z
        .enum(SEVERITY_LEVELS)
        .describe("Injury severity: mild (discomfort), moderate (limited movement), severe (cannot train)"),
      notes: z
        .string()
        .max(500)
        .optional()
        .describe("Additional details about the injury (when it occurred, what aggravates it)"),
      affectedExercises: z
        .array(z.string().min(1).max(200))
        .max(10)
        .optional()
        .describe("Specific exercises that aggravate the injury"),
      onsetDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
        .optional()
        .describe("When the injury occurred (YYYY-MM-DD)"),
    },
    async (params) => {
      const requestId = generateRequestId();
      const start = Date.now();

      try {
        // Auth & scope check
        const claims = getRequestAuth();
        if (!claims || !hasScope(claims.scope, "health:write")) {
          return {
            content: [{ type: "text" as const, text: "Error: health:write scope required" }],
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
        const profileRef = db.collection("profiles").doc(profileId);
        const profileDoc = await profileRef.get();

        if (!profileDoc.exists) {
          return {
            content: [{ type: "text" as const, text: "Profile not found" }],
            isError: true,
          };
        }

        const timestamp = new Date().toISOString();
        const injuryRecord: Record<string, unknown> = {
          body_part: params.bodyPart,
          severity: params.severity,
          notes: params.notes || null,
          affected_exercises: params.affectedExercises || [],
          onset_date: params.onsetDate || timestamp.split("T")[0],
          reported_at: timestamp,
          is_active: true,
          source: "mcp",
        };

        // Add to injuries array on the profile's training_context
        await profileRef.update({
          "training_context.injuries": FieldValue.arrayUnion(injuryRecord),
          "training_context.injury_history": true,
          mcp_updated_at: timestamp,
        });

        const coachingNote = generateCoachingNote(params.bodyPart, params.severity);

        const result = scrubDocument({
          bodyPart: params.bodyPart,
          severity: params.severity,
          isActive: true,
          coachingNote,
          affectedExercises: params.affectedExercises || [],
          message: `Injury recorded: ${params.severity} ${params.bodyPart.replace("_", " ")} injury. Training plan will adapt accordingly.`,
        });

        logToolCall({
          requestId,
          tool: "add_injury",
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
          tool: "add_injury",
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
