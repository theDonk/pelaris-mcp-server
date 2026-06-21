/**
 * MCP Resource: pelaris://coach/personality
 *
 * Data-presentation guidance only. This resource intentionally carries NO coach
 * persona, voice examples, anti-patterns, or voice principles.
 *
 * SECURITY (ST-6 §5 / A4 §5, Unified Uplift G6): this is the PUBLIC MCP repo
 * (world-readable forever). The previous version reproduced the coach's
 * proprietary Part-A voice contract here (persona name, verbatim coaching
 * lines, anti-pattern list, voice principles, and voice-adoption framing) which
 * is the exact class of leak automated secret scanners miss. It has been
 * reduced to neutral formatting/units/date hints that any client needs to
 * render Pelaris training data well and that reveal nothing of the coaching
 * voice. The voice contract lives only in wayfinder/functions (server-side).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const FORMATTING_GUIDANCE = {
  resource: "Pelaris training-data formatting guidance",
  purpose:
    "How to present Pelaris training data clearly when you show it to a user. " +
    "This is data-presentation guidance only, not a coaching persona or voice.",
  formatting: {
    dataReferences:
      "Reference the specific data points (weights, times, distances, dates) that appear in the tool results when they are available.",
    units:
      "Present weights and distances in the unit the user's profile indicates (preferredUnits: metric or imperial). Use what the data and profile specify rather than converting silently.",
    dateFormat: "Use the Australian date format, DD/MM/YYYY.",
    brevity: "Keep responses concise and lead with the answer the user asked for.",
  },
};

export function registerCoachPersonalityResource(server: McpServer): void {
  server.resource(
    "coach-personality",
    "pelaris://coach/personality",
    {
      description: "Formatting and units guidance for presenting Pelaris training data.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "pelaris://coach/personality",
          mimeType: "application/json",
          text: JSON.stringify(FORMATTING_GUIDANCE, null, 2),
        },
      ],
    }),
  );
}
