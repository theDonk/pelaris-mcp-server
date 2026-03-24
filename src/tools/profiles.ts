import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "../firestore-client.js";

const COLLECTION = "profiles";

export function registerProfileTools(server: McpServer): void {
  server.tool(
    "get_user_stats",
    "Get aggregate user statistics (counts only). No individual profile data is returned — privacy by design.",
    {},
    async () => {
      try {
        const snapshot = await db.collection(COLLECTION).count().get();
        const totalUsers = snapshot.data().count;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  totalUsers,
                  note: "Individual profile data is not accessible via MCP. Only aggregate counts are returned.",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }],
          isError: true,
        };
      }
    }
  );
}
