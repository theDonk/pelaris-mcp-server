/**
 * MCP Tool: manage_goals
 * Scope: training:write
 *
 * CRUD operations for user goals. Supports create, update, complete, and list actions.
 */

import crypto from "crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { profileSubcollection } from "../../firestore-client.js";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { checkWriteRateLimit } from "../../middleware/rate-limiter.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";

const VALID_ACTIONS = ["create", "update", "complete", "list"] as const;
const VALID_SOURCES = ["intake", "coach", "manual"] as const;
const VALID_DIRECTIONS = ["decrease", "increase", "maintain"] as const;

export function registerManageGoals(server: McpServer): void {
  server.tool(
    "manage_goals",
    "Create, update, complete, or list your training goals. Supports race events, body composition targets, and performance milestones.",
    {
      action: z
        .enum(VALID_ACTIONS)
        .describe("The action to perform: create, update, complete, or list"),
      // Create fields
      name: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe("Goal description (required for create)"),
      targetValue: z
        .string()
        .optional()
        .describe("Numeric target value (e.g., 100 for 100kg squat goal)"),
      targetDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
        .optional()
        .describe("Target completion date in YYYY-MM-DD format"),
      sport: z
        .string()
        .max(100)
        .optional()
        .describe("Sport category (e.g., 'running', 'strength', 'swimming')"),
      targetMetric: z
        .string()
        .max(100)
        .optional()
        .describe("Target metric key (e.g., 'waistCm', 'weightKg', 'squat_1rm')"),
      targetDirection: z
        .enum(VALID_DIRECTIONS)
        .optional()
        .describe("Direction of improvement: decrease, increase, or maintain"),
      source: z
        .enum(VALID_SOURCES)
        .optional()
        .describe("Origin of the goal (defaults to 'manual')"),
      // Event/race fields
      eventName: z
        .string()
        .max(300)
        .optional()
        .describe("Event name (e.g., 'Melbourne Marathon 2026')"),
      eventDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
        .optional()
        .describe("Event date in YYYY-MM-DD format"),
      eventDistance: z
        .string()
        .max(100)
        .optional()
        .describe("Event distance (e.g., '42.2km', '5K', 'Olympic')"),
      eventLocation: z
        .string()
        .max(300)
        .optional()
        .describe("Event location (e.g., 'Melbourne, Australia')"),
      // Update/complete fields
      goalId: z
        .string()
        .max(200)
        .optional()
        .describe("Goal ID (required for update and complete actions)"),
      actualValue: z
        .number()
        .optional()
        .describe("Actual achieved value (for complete action)"),
      reflectionNotes: z
        .string()
        .max(1000)
        .optional()
        .describe("Reflection notes when completing a goal"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
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

        // Write rate limit (skip for list — read-only)
        if (params.action !== "list") {
          const rateLimitError = checkWriteRateLimit(claims.sub);
          if (rateLimitError) {
            return {
              content: [{ type: "text" as const, text: `Error: ${rateLimitError}` }],
              isError: true,
            };
          }
        }

        const profileId = claims.profile_id;
        const goalsCol = profileSubcollection(profileId, "goals");

        // ── LIST ──────────────────────────────────────────────────
        if (params.action === "list") {
          const goalsSnap = await goalsCol.orderBy("date_created", "desc").limit(50).get();

          if (goalsSnap.empty) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ goals: [], message: "No goals found" }) }],
            };
          }

          const goals = goalsSnap.docs.map((doc) => {
            const d = doc.data();
            return {
              goalId: doc.id,
              description: d.description,
              isCompleted: d.is_completed || false,
              dateCreated: d.date_created || null,
              targetDate: d.target_date || null,
              targetValue: d.target_value ?? null,
              targetMetric: d.target_metric || null,
              targetDirection: d.target_direction || null,
              source: d.source || null,
              eventName: d.event_name || null,
              eventDate: d.event_date || null,
              eventDistance: d.event_distance || null,
              eventLocation: d.event_location || null,
            };
          });

          const result = scrubDocument({ goals } as Record<string, unknown>);

          logToolCall({
            requestId,
            tool: "manage_goals",
            userPseudonym: claims.sub,
            latencyMs: Date.now() - start,
            success: true,
          });

          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        // ── CREATE ────────────────────────────────────────────────
        if (params.action === "create") {
          if (!params.name) {
            return {
              content: [{ type: "text" as const, text: "Error: 'name' is required for create action" }],
              isError: true,
            };
          }

          const goalId = crypto.randomUUID();
          const now = new Date().toISOString();

          const goalData: Record<string, unknown> = {
            id: goalId,
            description: params.name,
            is_completed: false,
            date_created: now,
            target_date: params.targetDate || null,
            linked_benchmark_ids: null,
            source: params.source || "manual",
          };

          // Optional fields
          if (params.targetValue != null) goalData.target_value = params.targetValue;
          if (params.targetMetric) goalData.target_metric = params.targetMetric;
          if (params.targetDirection) goalData.target_direction = params.targetDirection;
          if (params.eventName) goalData.event_name = params.eventName;
          if (params.eventDate) goalData.event_date = params.eventDate;
          if (params.eventDistance) goalData.event_distance = params.eventDistance;
          if (params.eventLocation) goalData.event_location = params.eventLocation;

          await goalsCol.doc(goalId).set(goalData);

          const result = scrubDocument({
            goalId,
            action: "created",
            description: params.name,
            targetDate: params.targetDate || null,
            eventName: params.eventName || null,
            message: `Goal created: "${params.name}"`,
          });

          logToolCall({
            requestId,
            tool: "manage_goals",
            userPseudonym: claims.sub,
            latencyMs: Date.now() - start,
            success: true,
          });

          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        // ── UPDATE ────────────────────────────────────────────────
        if (params.action === "update") {
          if (!params.goalId) {
            return {
              content: [{ type: "text" as const, text: "Error: 'goalId' is required for update action" }],
              isError: true,
            };
          }

          const docRef = goalsCol.doc(params.goalId);
          const existingDoc = await docRef.get();
          if (!existingDoc.exists) {
            return {
              content: [{ type: "text" as const, text: `Error: Goal "${params.goalId}" not found` }],
              isError: true,
            };
          }

          const updates: Record<string, unknown> = {};
          if (params.name) updates.description = params.name;
          if (params.targetDate) updates.target_date = params.targetDate;
          if (params.targetValue != null) updates.target_value = params.targetValue;
          if (params.targetMetric) updates.target_metric = params.targetMetric;
          if (params.targetDirection) updates.target_direction = params.targetDirection;
          if (params.eventName) updates.event_name = params.eventName;
          if (params.eventDate) updates.event_date = params.eventDate;
          if (params.eventDistance) updates.event_distance = params.eventDistance;
          if (params.eventLocation) updates.event_location = params.eventLocation;

          if (Object.keys(updates).length === 0) {
            return {
              content: [{ type: "text" as const, text: "Error: No fields provided to update" }],
              isError: true,
            };
          }

          await docRef.update(updates);

          const result = scrubDocument({
            goalId: params.goalId,
            action: "updated",
            fieldsUpdated: Object.keys(updates),
            message: `Goal "${params.goalId}" updated: ${Object.keys(updates).join(", ")}`,
          });

          logToolCall({
            requestId,
            tool: "manage_goals",
            userPseudonym: claims.sub,
            latencyMs: Date.now() - start,
            success: true,
          });

          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        // ── COMPLETE ──────────────────────────────────────────────
        if (params.action === "complete") {
          if (!params.goalId) {
            return {
              content: [{ type: "text" as const, text: "Error: 'goalId' is required for complete action" }],
              isError: true,
            };
          }

          const docRef = goalsCol.doc(params.goalId);
          const existingDoc = await docRef.get();
          if (!existingDoc.exists) {
            return {
              content: [{ type: "text" as const, text: `Error: Goal "${params.goalId}" not found` }],
              isError: true,
            };
          }

          const completionData: Record<string, unknown> = {
            is_completed: true,
            completed_at: new Date().toISOString(),
          };
          if (params.actualValue != null) completionData.actual_value = params.actualValue;
          if (params.reflectionNotes) completionData.reflection_notes = params.reflectionNotes;

          await docRef.update(completionData);

          const goalData = existingDoc.data()!;
          const result = scrubDocument({
            goalId: params.goalId,
            action: "completed",
            description: goalData.description,
            actualValue: params.actualValue ?? null,
            reflectionNotes: params.reflectionNotes ?? null,
            message: `Goal completed: "${goalData.description}"`,
          });

          logToolCall({
            requestId,
            tool: "manage_goals",
            userPseudonym: claims.sub,
            latencyMs: Date.now() - start,
            success: true,
          });

          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        return {
          content: [{ type: "text" as const, text: `Error: Unknown action "${params.action}"` }],
          isError: true,
        };
      } catch (error) {
        logToolCall({
          requestId,
          tool: "manage_goals",
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
