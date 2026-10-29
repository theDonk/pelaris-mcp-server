/**
 * The `serverInfo` every MCP client receives in the `initialize` result (MCP_FIXES.md §2).
 *
 * Clients show it to people: Gemini names a custom app after it (it showed
 * "Pelaris Firebase Mcp" for the old internal name, 29/10/2026). `name` is the
 * programmatic id and `title` the display name (MCP 2025-06-18+); both are the
 * brand. The npm package name, the `/health` `service` field and the startup log
 * keep "pelaris-firebase-mcp": they are ops-facing, never shown to a user.
 */
export const SERVER_NAME = "Pelaris";
export const SERVER_TITLE = "Pelaris";

export function serverInfo(version: string): { name: string; title: string; version: string } {
  return { name: SERVER_NAME, title: SERVER_TITLE, version };
}
