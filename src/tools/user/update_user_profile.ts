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
import { callCoreBridge } from "../shared/bridge_client.js";

/** Allowed equipment values. */
const VALID_EQUIPMENT = [
  "barbell", "dumbbells", "kettlebell", "pull_up_bar", "resistance_bands",
  "cable_machine", "leg_press", "smith_machine", "bench", "squat_rack",
  "rowing_machine", "stationary_bike", "treadmill", "swimming_pool",
  "foam_roller", "medicine_ball", "trx", "none",
] as const;

/** Allowed availability days. */
const VALID_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

/** Where the athlete is in their season. */
const SEASON_PHASES = ["in_season", "off_season", "pre_season"] as const;

/**
 * The sport the athlete plays and when (1.4 B2c, TS-7). Validated by the wayfinder
 * core, which owns the one sport list: this schema holds no sport vocabulary of
 * its own beyond the hint text, so an id the core does not know is refused there
 * with `unknown_sport_id`.
 */
export const teamSportField = z
  .object({
    sportId: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe(
        "A sport id: afl, soccer, rugby_league, rugby_union, netball, cricket, basketball, gaelic_football, field_hockey, ice_hockey, american_football, baseball, tennis, or other. " +
        "If the athlete says only 'rugby' or 'hockey', ask which code first. A sport not listed is 'other' with sportLabel.",
      ),
    sportLabel: z.string().min(1).max(60).optional().describe("The athlete's own words for the sport, used with sportId 'other'"),
    matchDays: z.array(z.enum(VALID_DAYS)).max(7).optional().describe("Match or game days"),
    trainingDays: z.array(z.enum(VALID_DAYS)).max(7).optional().describe("Club or team training days"),
    recoveryDaysNeeded: z.number().int().min(0).max(2).optional().describe("Days needed to recover after a match (0 to 2)"),
    seasonPhase: z.enum(SEASON_PHASES).optional().describe("Where the athlete is in their season; write it only when they tell you"),
    notPlaying: z.boolean().optional().describe("True when the athlete says they do not play a team sport"),
  })
  .strict();

export function registerUpdateUserProfile(server: McpServer): void {
  server.registerTool(
    "update_profile",
    {
      title: "Update Profile",
      description: "Update your training preferences — equipment, available days, session duration, experience level, and more.",
      inputSchema: {
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
        teamSport: teamSportField
          .optional()
          .describe("The sport the athlete plays and when: sport, match days, club training days, recovery, season. Include only what changed."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true, title: "Update Profile" },
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
          params.poolLength || params.environment || params.teamSport;

        if (!hasUpdates) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "no_changes",
                message: "No changes specified. Provide at least one field to update (equipment, availableDays, sessionsPerWeek, preferredSessionDuration, preferredUnits, experienceLevel, poolLength, environment, teamSport).",
              }, null, 2),
            }],
          };
        }

        const profileId = claims.profile_id;

        // 1.4 B2c (TS-7): the team sport goes to the wayfinder core's update_athlete over
        // the bridge, the one validated writer (registry ids only, origin coach, server
        // time), for the token's own profile only. It runs first so a refusal (a closed
        // code, never the typed input) stops the call before anything else is written,
        // and there is no direct-write fallback.
        if (params.teamSport) {
          const bridged = await callCoreBridge("update_athlete", profileId, { type: "profile", teamSport: params.teamSport });
          if (!bridged.ok || bridged.result == null) {
            logToolCall({
              requestId,
              tool: "update_user_profile",
              latencyMs: Date.now() - start,
              success: false,
              error: bridged.error ?? "bridge_failed",
            });
            return {
              content: [{ type: "text" as const, text: `Error: ${bridged.error ?? "unknown error"}` }],
              isError: true,
            };
          }
        }

        const onlyTeamSport = !!params.teamSport && !(params.equipment || params.availableDays || params.sessionsPerWeek != null ||
          params.preferredSessionDuration != null || params.preferredUnits || params.experienceLevel ||
          params.poolLength || params.environment);
        const profileRef = db.collection("profiles").doc(profileId);
        const profileDoc = onlyTeamSport ? null : await profileRef.get();

        if (profileDoc && !profileDoc.exists) {
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

        if (params.teamSport) updatedFields.push("teamSport");

        // Add metadata
        updates["mcp_updated_at"] = new Date().toISOString();

        // A team-sport-only call has already been written by the core.
        if (!onlyTeamSport) await profileRef.update(updates);

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
