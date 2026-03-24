import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { verifyBearerToken } from "./auth.js";
import { registerResearchTools } from "./tools/research.js";
import { registerPipelineTools } from "./tools/pipeline.js";
import { registerFeedbackTools } from "./tools/feedback.js";
import { registerProfileTools } from "./tools/profiles.js";
const PORT = parseInt(process.env.PORT || "8080", 10);
const app = express();
app.use(express.json());
// Health check (no auth)
app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "pelaris-firebase-mcp" });
});
// MCP endpoint — stateless mode (fresh server per request)
app.post("/mcp", verifyBearerToken, async (req, res) => {
    try {
        const server = new McpServer({
            name: "pelaris-firebase-mcp",
            version: "1.0.0",
        });
        // Register all tool groups
        registerResearchTools(server);
        registerPipelineTools(server);
        registerFeedbackTools(server);
        registerProfileTools(server);
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // stateless — no session management
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    }
    catch (error) {
        console.error("MCP request error:", error);
        if (!res.headersSent) {
            res.status(500).json({ error: "Internal server error" });
        }
    }
});
// Handle GET and DELETE on /mcp (required by Streamable HTTP spec)
app.get("/mcp", verifyBearerToken, async (_req, res) => {
    res.status(405).json({ error: "Method not allowed — use POST for stateless mode" });
});
app.delete("/mcp", verifyBearerToken, async (_req, res) => {
    res.status(405).json({ error: "Method not allowed — stateless mode, no sessions to close" });
});
app.listen(PORT, () => {
    console.log(`pelaris-firebase-mcp listening on port ${PORT}`);
});
//# sourceMappingURL=index.js.map