/**
 * Every card the server offers. Add a new card's definition here (one line) and its
 * `ui://` resource is registered with the rest; see docs/CARDS.md.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCardResources, type CardDefinition } from "./card_shell.js";
import { SESSION_CARD } from "./session_card.js";
import { WEEK_CARD } from "./week_card.js";
import { DEBRIEF_CARD } from "./debrief_card.js";
import { BODY_CARD } from "./body_card.js";

export const CARDS: readonly CardDefinition[] = [SESSION_CARD, WEEK_CARD, DEBRIEF_CARD, BODY_CARD];

export function registerCards(server: McpServer, env: NodeJS.ProcessEnv = process.env): void {
  registerCardResources(server, CARDS, env);
}
