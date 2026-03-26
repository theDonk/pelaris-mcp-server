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

const VALID_SIDES = ["left", "right", "bilateral"] as const;

const SEVERITY_LEVELS = ["mild", "moderate", "severe"] as const;

/**
 * Normalize a body part input by stripping side prefixes and matching against known parts.
 * E.g. "left knee" → { bodyPart: "knee", side: "left" }
 */
function normalizeBodyPartInput(
  raw: string,
  explicitSide?: string,
): { bodyPart: string; side: string | null } {
  let input = raw.toLowerCase().trim();
  let detectedSide: string | null = explicitSide || null;

  // Strip side prefixes if present
  for (const side of ["left", "right", "bilateral"]) {
    if (input.startsWith(side + " ")) {
      if (!detectedSide) detectedSide = side;
      input = input.slice(side.length).trim();
      break;
    }
    // Also handle trailing side: "knee left"
    if (input.endsWith(" " + side)) {
      if (!detectedSide) detectedSide = side;
      input = input.slice(0, -side.length).trim();
      break;
    }
  }

  // Replace spaces with underscores for matching (e.g. "upper back" → "upper_back")
  const normalized = input.replace(/\s+/g, "_");

  // Direct match
  if ((VALID_BODY_PARTS as readonly string[]).includes(normalized)) {
    return { bodyPart: normalized, side: detectedSide };
  }

  // Try without underscores match (e.g. "upperback" → "upper_back")
  for (const part of VALID_BODY_PARTS) {
    if (part.replace("_", "") === normalized.replace("_", "")) {
      return { bodyPart: part, side: detectedSide };
    }
  }

  // Fallback: return as-is (Zod will catch truly invalid values)
  return { bodyPart: normalized, side: detectedSide };
}

/** Generate coaching note based on severity and body part. */
function generateCoachingNote(bodyPart: string, severity: string, side?: string | null): string {
  const partLabel = bodyPart.replace("_", " ");
  const sideLabel = side ? `${side} ` : "";
  const fullLabel = `${sideLabel}${partLabel}`;

  switch (severity) {
    case "severe":
      return `Noted: severe ${fullLabel} injury. All exercises involving the ${fullLabel} will be removed or replaced in upcoming sessions. Please consult a medical professional before resuming training. Your plan will focus on unaffected areas in the meantime.`;
    case "moderate":
      return `Noted: moderate ${fullLabel} injury. Exercises loading the ${fullLabel} will be reduced in intensity and volume. Alternative movements will be suggested where possible. Monitor for any worsening.`;
    case "mild":
      return `Noted: mild ${fullLabel} discomfort. Training will continue with modifications — lighter loads and reduced range of motion for exercises involving the ${fullLabel}. Flag any increase in pain.`;
    default:
      return `Noted: ${fullLabel} injury recorded. Training will be adjusted accordingly.`;
  }
}

export function registerAddInjury(server: McpServer): void {
  server.tool(
    "record_injury",
    "Log an injury or pain point so your training plan adapts automatically. Returns a coaching note about how sessions will adjust.",
    {
      bodyPart: z
        .string()
        .min(1)
        .max(100)
        .describe("Body part affected by the injury (e.g. 'knee', 'left knee', 'lower_back')"),
      side: z
        .enum(VALID_SIDES)
        .optional()
        .describe("Side of the body affected (left/right/bilateral). Auto-detected if included in bodyPart."),
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
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
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

        // Normalize bodyPart input — extract side if embedded, match against valid parts
        const normalized = normalizeBodyPartInput(params.bodyPart, params.side);
        const resolvedBodyPart = normalized.bodyPart;
        const resolvedSide = normalized.side;

        // Validate the resolved bodyPart against known values
        if (!(VALID_BODY_PARTS as readonly string[]).includes(resolvedBodyPart)) {
          return {
            content: [{
              type: "text" as const,
              text: `Unknown body part "${params.bodyPart}". Valid options: ${VALID_BODY_PARTS.join(", ")}. You can prefix with left/right (e.g. "left knee").`,
            }],
            isError: true,
          };
        }

        const timestamp = new Date().toISOString();
        const injuryRecord: Record<string, unknown> = {
          body_part: resolvedBodyPart,
          side: resolvedSide || null,
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

        const coachingNote = generateCoachingNote(resolvedBodyPart, params.severity, resolvedSide);
        const sideLabel = resolvedSide ? `${resolvedSide} ` : "";

        const result = scrubDocument({
          bodyPart: resolvedBodyPart,
          side: resolvedSide || null,
          severity: params.severity,
          isActive: true,
          coachingNote,
          affectedExercises: params.affectedExercises || [],
          message: `Injury recorded: ${params.severity} ${sideLabel}${resolvedBodyPart.replace("_", " ")} injury. Training plan will adapt accordingly.`,
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
