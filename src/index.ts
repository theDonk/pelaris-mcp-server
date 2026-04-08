import { readFileSync } from "fs";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { verifyBearerToken, type McpAuthenticatedRequest } from "./auth.js";
import { rateLimiter } from "./middleware/rate-limiter.js";
import { logServer, generateRequestId } from "./logger.js";
import { runWithAuth, setRequestAuth, clearRequestAuth } from "./request-context.js";

// Single source of truth for version — reads from package.json
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
const VERSION: string = pkg.version;

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
import { registerGetGenerationStatus } from "./tools/user/get_generation_status.js";

// User write tools (OAuth-scoped — PEL-69)
import { registerGenerateWeeklyPlan } from "./tools/user/generate_weekly_plan.js";
import { registerModifyTrainingSession } from "./tools/user/modify_training_session.js";
import { registerLogWorkout } from "./tools/user/log_workout.js";
import { registerSwapExercise } from "./tools/user/swap_exercise.js";
import { registerUpdateUserProfile } from "./tools/user/update_user_profile.js";
import { registerAddInjury } from "./tools/user/add_injury.js";
import { registerLogCoachFeedback } from "./tools/user/log_coach_feedback.js";
import { registerCreatePlannedSession } from "./tools/user/create_planned_session.js";
import { registerDeleteSession } from "./tools/user/delete_session.js";
import { registerLogCompletedSession } from "./tools/user/log_completed_session.js";
import { registerUpdateSession } from "./tools/user/update_session.js";

// User tools — coach-parity (PEL-XX)
import { registerRecordBenchmark } from "./tools/user/record_benchmark.js";
import { registerCheckIn } from "./tools/user/check_in.js";
import { registerManageGoals } from "./tools/user/manage_goals.js";
import { registerManageProgram } from "./tools/user/manage_program.js";
import { registerGetWeeklyDebrief } from "./tools/user/get_weekly_debrief.js";

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
  res.json({ status: "ok", service: "pelaris-firebase-mcp", version: VERSION });
});

// OpenAI domain verification
app.get("/.well-known/openai-apps-challenge", (_req, res) => {
  res.type("text/plain").send("zbLSUJf6Kge9PIshQ5An4F-NPfXEad4cmKH7XMdZSAk");
});

// Favicon — serve Pelaris logo
import path from "path";
app.get("/favicon.ico", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "favicon.png"), {
    headers: { "Content-Type": "image/png" },
  });
});

// ── OAuth proxy endpoints ────────────────────────────────────────────────────
// Per MCP spec (2025-03-26), clients derive the authorization base URL by
// stripping the path from the MCP server URL and use default paths (/register,
// /authorize, /token) when metadata discovery fails or is ignored.
// Claude uses these defaults, so we proxy them to the actual OAuth CF.
const OAUTH_CF_BASE = process.env.OAUTH_CF_BASE || "https://australia-southeast1-wayfinder-ai-fitness.cloudfunctions.net/mcpOAuthServer";

// POST /register — Dynamic Client Registration (DCR) for third-party apps.
// Pre-registered clients (pelaris-claude, pelaris-chatgpt) bypass this.
// DCR is idempotent: same redirect_uris returns the same client_id.
app.post("/register", async (req, res) => {
  try {
    const { redirect_uris, client_name } = req.body || {};

    if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      res.status(400).json({ error: "invalid_request", error_description: "redirect_uris required" });
      return;
    }

    // Idempotency: hash redirect_uris to create a deterministic client_id
    const crypto = await import("crypto");
    const uriHash = crypto.createHash("sha256")
      .update(redirect_uris.sort().join("|"))
      .digest("hex")
      .slice(0, 32);
    const clientId = `dyn-${uriHash}`;

    // Check if this client already exists in Firestore
    const { db: firestoreDb } = await import("./firestore-client.js");
    const dbRef = firestoreDb.collection("mcp_clients").doc(clientId);
    const existing = await dbRef.get();

    if (existing.exists) {
      // Return existing client — idempotent
      const data = existing.data()!;
      res.status(200).json({
        client_id: clientId,
        client_name: data.client_name || client_name || "MCP Client",
        redirect_uris: data.redirect_uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
      return;
    }

    // Create new dynamic client
    await dbRef.set({
      client_name: client_name || "MCP Client",
      redirect_uris,
      platform: "direct",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      created_at: new Date().toISOString(),
    });

    res.status(201).json({
      client_id: clientId,
      client_name: client_name || "MCP Client",
      redirect_uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  } catch (err) {
    console.error("[register] DCR failed:", err);
    res.status(500).json({ error: "server_error", error_description: "Registration failed" });
  }
});

// GET /authorize → redirect to OAuth CF authorization endpoint
app.get("/authorize", (req, res) => {
  const qs = new URLSearchParams(req.query as Record<string, string>).toString();
  res.redirect(302, `${OAUTH_CF_BASE}/oauth/authorize?${qs}`);
});

// POST /token → proxy to OAuth CF token endpoint
// OAuth spec requires application/x-www-form-urlencoded for token requests
app.post("/token", express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const contentType = req.headers["content-type"] || "";
    let upstream: Response;

    if (contentType.includes("application/x-www-form-urlencoded")) {
      // Forward as form-encoded (per OAuth spec)
      const formBody = new URLSearchParams(req.body as Record<string, string>).toString();
      upstream = await fetch(`${OAUTH_CF_BASE}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formBody,
      });
    } else {
      // Forward as JSON (fallback)
      upstream = await fetch(`${OAUTH_CF_BASE}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
      });
    }

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error("[oauth-proxy] /token failed:", err);
    res.status(502).json({ error: "proxy_error", error_description: "Failed to reach authorization server" });
  }
});

// POST /revoke → proxy to OAuth CF revocation endpoint
app.post("/revoke", express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const contentType = req.headers["content-type"] || "";
    let upstream: Response;

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const formBody = new URLSearchParams(req.body as Record<string, string>).toString();
      upstream = await fetch(`${OAUTH_CF_BASE}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formBody,
      });
    } else {
      upstream = await fetch(`${OAUTH_CF_BASE}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
      });
    }

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error("[oauth-proxy] /revoke failed:", err);
    res.status(502).json({ error: "proxy_error", error_description: "Failed to reach authorization server" });
  }
});

// OAuth 2.0 Authorization Server Metadata (RFC 8414)
const OAUTH_BASE = "https://australia-southeast1-wayfinder-ai-fitness.cloudfunctions.net/mcpOAuthServer";
const MCP_SERVER_URL = "https://api.pelaris.io";

// RFC 8414 — Authorization Server Metadata
// CRITICAL: issuer and all endpoints must be on the MCP server domain.
// Claude derives the AS metadata URL from the issuer by stripping the path
// and fetching /.well-known/oauth-authorization-server on that domain.
// If issuer points to a different domain (like our CF), Claude can't discover it.
app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json({
    issuer: MCP_SERVER_URL,
    authorization_endpoint: `${MCP_SERVER_URL}/authorize`,
    token_endpoint: `${MCP_SERVER_URL}/token`,
    registration_endpoint: `${MCP_SERVER_URL}/register`,
    revocation_endpoint: `${MCP_SERVER_URL}/revoke`,
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

// RFC 9728 — Protected Resource Metadata
// authorization_servers must point to the MCP server (same domain as issuer above)
app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: MCP_SERVER_URL,
    authorization_servers: [MCP_SERVER_URL],
    scopes_supported: [
      "profile:read", "training:read", "training:write",
      "health:read", "health:write", "coach:read",
    ],
    bearer_methods_supported: ["header"],
  });
});

// Path-aware variant (Claude checks both per RFC 9728)
app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
  res.json({
    resource: `${MCP_SERVER_URL}/mcp`,
    authorization_servers: [MCP_SERVER_URL],
    scopes_supported: [
      "profile:read", "training:read", "training:write",
      "health:read", "health:write", "coach:read",
    ],
    bearer_methods_supported: ["header"],
  });
});

// MCP endpoint — stateless mode (fresh server per request)
app.post("/mcp", verifyBearerToken, rateLimiter, async (req: McpAuthenticatedRequest, res) => {
  const requestId = generateRequestId();
  const authContext = req.mcpAuth || null;

  // PEL-122: Use AsyncLocalStorage for concurrency-safe per-request auth context
  await runWithAuth(authContext, async () => {
  try {
    const server = new McpServer({
      name: "pelaris-firebase-mcp",
      version: VERSION,
    });

    // ─── Admin tools (only for admin-authed requests) ───────────
    if (req.isAdminAuth) {
      registerResearchTools(server);
      registerPipelineTools(server);
      registerFeedbackTools(server);
      registerProfileTools(server);
    }

    // ─── User coaching tools (OAuth-scoped) ─────────────────────
    registerGetTrainingContext(server);
    registerGetActiveProgram(server);
    registerGetSessionDetails(server);
    registerGetBenchmarks(server);
    registerGetBodyAnalysis(server);
    registerSearchEngineResources(server);
    registerGetCoachInsight(server);
    registerGetOnboardingStatus(server);
    registerGetGenerationStatus(server);

    // ─── User write tools (OAuth-scoped — PEL-69) ────────────────
    registerGenerateWeeklyPlan(server);
    registerModifyTrainingSession(server);
    registerLogWorkout(server);
    registerSwapExercise(server);
    registerUpdateUserProfile(server);
    registerAddInjury(server);
    registerLogCoachFeedback(server);
    registerCreatePlannedSession(server);
    registerDeleteSession(server);
    registerLogCompletedSession(server);
    registerUpdateSession(server);

    // ─── Coach-parity tools ─────────────────────────────────
    registerRecordBenchmark(server);
    registerCheckIn(server);
    registerManageGoals(server);
    registerManageProgram(server);
    registerGetWeeklyDebrief(server);

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
  }
  }); // end runWithAuth
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
