import { db } from "../firestore-client.js";
const COLLECTION = "profiles";
export function registerProfileTools(server) {
    server.tool("get_user_stats", "Get aggregate user statistics (counts only). No individual profile data is returned — privacy by design.", {}, async () => {
        try {
            const snapshot = await db.collection(COLLECTION).count().get();
            const totalUsers = snapshot.data().count;
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            totalUsers,
                            note: "Individual profile data is not accessible via MCP. Only aggregate counts are returned.",
                        }, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            return {
                content: [{ type: "text", text: `Error: ${error.message}` }],
                isError: true,
            };
        }
    });
}
//# sourceMappingURL=profiles.js.map