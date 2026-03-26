/**
 * MCP Tool: update_user_profile
 * Scope: training:write
 *
 * Updates specific fields on the user's profile document.
 * Validates fields against a known schema to prevent arbitrary writes.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "../../firestore-client.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { checkWriteRateLimit } from "../../middleware/rate-limiter.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";

/** Allowed equipment values. */
const VALID_EQUIPMENT = [
  "barbell", "dumbbells", "kettlebell", "pull_up_bar", "resistance_bands",
  "cable_machine", "leg_press", "smith_machine", "bench", "squat_rack",
  "rowing_machine", "stationary_bike", "treadmill", "swimming_pool",
  "foam_roller", "medicine_ball", "trx", "none",
] as const;

/** Allowed availability days. */
const VALID_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

export function registerUpdateUserProfile(server: McpServer): void {
  server.tool(
    "update_profile",
    "Update your training preferences — equipment, available days, session duration, experience level, and more.",
    {
      equipment: z
        .array(z.enum(VALID_EQUIPMENT))
        .min(1)
        .max(20)
        .optional()
        .describe("List of available equipment"),
      availableDays: z
        .array(z.enum(VALID_DAYS))
        .min(1)
        .max(7)
        .optional()
        .describe("Days of the week available for training"),
      sessionsPerWeek: z
        .number()
        .int()
        .min(1)
        .max(14)
        .optional()
        .describe("Preferred number of sessions per week"),
      preferredSessionDuration: z
        .number()
        .int()
        .min(15)
        .max(180)
        .optional()
        .describe("Preferred session duration in minutes (15-180)"),
      preferredUnits: z
        .enum(["metric", "imperial"])
        .optional()
        .describe("Preferred measurement units"),
      experienceLevel: z
        .enum(["beginner", "intermediate", "advanced", "elite"])
        .optional()
        .describe("Training experience level"),
      poolLength: z
        .enum(["25m", "50m", "open_water"])
        .optional()
        .describe("Swimming pool length (for swim-specific training)"),
      environment: z
        .enum(["gym", "home", "outdoor", "pool", "mixed"])
        .optional()
        .describe("Primary training environment"),
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
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

        // Validate at least one field provided
        const hasUpdates = params.equipment || params.availableDays || params.sessionsPerWeek != null ||
          params.preferredSessionDuration != null || params.preferredUnits || params.experienceLevel ||
          params.poolLength || params.environment;

        if (!hasUpdates) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "no_changes",
                message: "No changes specified. Provide at least one field to update (equipment, availableDays, sessionsPerWeek, preferredSessionDuration, preferredUnits, experienceLevel, poolLength, environment).",
              }, null, 2),
            }],
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

        // Build update object — only include provided fields
        const updates: Record<string, unknown> = {};
        const updatedFields: string[] = [];

        if (params.equipment) {
          updates["training_context.equipment"] = params.equipment;
          updatedFields.push("equipment");
        }
        if (params.availableDays) {
          updates["preferences.available_days"] = params.availableDays;
          updatedFields.push("availableDays");
        }
        if (params.sessionsPerWeek != null) {
          updates["preferences.sessions_per_week"] = params.sessionsPerWeek;
          updatedFields.push("sessionsPerWeek");
        }
        if (params.preferredSessionDuration != null) {
          updates["preferences.preferred_session_duration"] = params.preferredSessionDuration;
          updatedFields.push("preferredSessionDuration");
        }
        if (params.preferredUnits) {
          updates["preferredUnits"] = params.preferredUnits;
          updatedFields.push("preferredUnits");
        }
        if (params.experienceLevel) {
          updates["training_context.experience_level"] = params.experienceLevel;
          updatedFields.push("experienceLevel");
        }
        if (params.poolLength) {
          updates["training_context.pool_length"] = params.poolLength;
          updatedFields.push("poolLength");
        }
        if (params.environment) {
          updates["training_context.environment"] = params.environment;
          updatedFields.push("environment");
        }

        // Add metadata
        updates["mcp_updated_at"] = new Date().toISOString();

        await profileRef.update(updates);

        const result = scrubDocument({
          updatedFields,
          message: `Profile updated successfully: ${updatedFields.join(", ")}`,
        });

        logToolCall({
          requestId,
          tool: "update_user_profile",
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
          tool: "update_user_profile",
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
