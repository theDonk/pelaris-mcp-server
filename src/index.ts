import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { verifyBearerToken, type McpAuthenticatedRequest } from "./auth.js";
import { rateLimiter } from "./middleware/rate-limiter.js";
import { logServer, generateRequestId } from "./logger.js";
import { setRequestAuth, clearRequestAuth } from "./request-context.js";

// Admin tools (existing — static bearer token auth)
import { registerResearchTools } from "./tools/research.js";
import { registerPipelineTools } from "./tools/pipeline.js";
import { registerFeedbackTools } from "./tools/feedback.js";
import { registerProfileTools } from "./tools/profiles.js";

// User coaching tools (new — OAuth-scoped)
import { registerGetTrainingContext } from "./tools/user/get_training_context.js";
import { registerGetActiveProgram } from "./tools/user/get_active_program.js";
import { registerGetSessionDetails } from "./tools/user/get_session_details.js";
import { registerGetBenchmarks } from "./tools/user/get_benchmarks.js";
import { registerGetBodyAnalysis } from "./tools/user/get_body_analysis.js";
import { registerSearchEngineResources } from "./tools/user/search_engine_resources.js";
import { registerGetCoachInsight } from "./tools/user/get_coach_insight.js";
import { registerGetOnboardingStatus } from "./tools/user/get_onboarding_status.js";

// User write tools (OAuth-scoped — PEL-69)
import { registerGenerateWeeklyPlan } from "./tools/user/generate_weekly_plan.js";
import { registerModifyTrainingSession } from "./tools/user/modify_training_session.js";
import { registerLogWorkout } from "./tools/user/log_workout.js";
import { registerSwapExercise } from "./tools/user/swap_exercise.js";
import { registerUpdateUserProfile } from "./tools/user/update_user_profile.js";
import { registerAddInjury } from "./tools/user/add_injury.js";
import { registerLogCoachFeedback } from "./tools/user/log_coach_feedback.js";

// Resources
import { registerCoachPersonalityResource } from "./resources/coach_personality.js";
import { registerMethodologiesResource } from "./resources/methodologies.js";

// Prompts
import { registerWeeklyPlanReviewPrompt } from "./prompts/weekly_plan_review.js";
import { registerSessionDebriefPrompt } from "./prompts/session_debrief.js";
import { registerBenchmarkCheckInPrompt } from "./prompts/benchmark_check_in.js";

const PORT = parseInt(process.env.PORT || "8080", 10);

const app = express();
app.use(express.json());

// Health check (no auth)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "pelaris-firebase-mcp", version: "1.2.0" });
});

// OAuth 2.0 Authorization Server Metadata (RFC 8414)
// Claude and ChatGPT look for this at the MCP server's own URL
const OAUTH_BASE = "https://australia-southeast1-wayfinder-ai-fitness.cloudfunctions.net/mcpOAuthServer";
app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json({
    issuer: OAUTH_BASE,
    authorization_endpoint: `${OAUTH_BASE}/oauth/authorize`,
    token_endpoint: `${OAUTH_BASE}/oauth/token`,
    revocation_endpoint: `${OAUTH_BASE}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [
      "profile:read", "training:read", "training:write",
      "health:read", "health:write", "coach:read",
    ],
    token_endpoint_auth_methods_supported: ["none"],
  });
});

// MCP endpoint — stateless mode (fresh server per request)
app.post("/mcp", verifyBearerToken, rateLimiter, async (req: McpAuthenticatedRequest, res) => {
  const requestId = generateRequestId();
  try {
    // Inject auth claims into per-request context for tool handlers
    setRequestAuth(req.mcpAuth || null);

    const server = new McpServer({
      name: "pelaris-firebase-mcp",
      version: "1.2.0",
    });

    // ─── Admin tools (existing) ─────────────────────────────────
    registerResearchTools(server);
    registerPipelineTools(server);
    registerFeedbackTools(server);
    registerProfileTools(server);

    // ─── User coaching tools (OAuth-scoped) ─────────────────────
    registerGetTrainingContext(server);
    registerGetActiveProgram(server);
    registerGetSessionDetails(server);
    registerGetBenchmarks(server);
    registerGetBodyAnalysis(server);
    registerSearchEngineResources(server);
    registerGetCoachInsight(server);
    registerGetOnboardingStatus(server);

    // ─── User write tools (OAuth-scoped — PEL-69) ────────────────
    registerGenerateWeeklyPlan(server);
    registerModifyTrainingSession(server);
    registerLogWorkout(server);
    registerSwapExercise(server);
    registerUpdateUserProfile(server);
    registerAddInjury(server);
    registerLogCoachFeedback(server);

    // ─── Resources ──────────────────────────────────────────────
    registerCoachPersonalityResource(server);
    registerMethodologiesResource(server);

    // ─── Prompts ────────────────────────────────────────────────
    registerWeeklyPlanReviewPrompt(server);
    registerSessionDebriefPrompt(server);
    registerBenchmarkCheckInPrompt(server);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no session management
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    logServer("MCP request error", { requestId, error: (error as Error).message });
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  } finally {
    clearRequestAuth();
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
  logServer(`pelaris-firebase-mcp listening on port ${PORT}`);
});
