/**
 * The `serverInfo` every MCP client receives in the `initialize` result. Clients show it to
 * people (some name the connection after it), so `name` (the programmatic id) and `title` (the
 * display name, MCP 2025-06-18+) are both the brand. The npm package name, the `/health`
 * `service` field and the startup log keep "pelaris-firebase-mcp": they are ops-facing.
 */
export const SERVER_NAME = "Pelaris";
export const SERVER_TITLE = "Pelaris";

export function serverInfo(version: string): { name: string; title: string; version: string } {
  return { name: SERVER_NAME, title: SERVER_TITLE, version };
}
