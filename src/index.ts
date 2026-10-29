import { readFileSync } from "fs";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { verifyBearerToken, type McpAuthenticatedRequest } from "./auth.js";
import { corsMiddleware } from "./middleware/cors.js";
import { rateLimiter } from "./middleware/rate-limiter.js";
import { mcpProtocolLog, mcpRequestIdFor, mcpStepsFor, timedStep } from "./middleware/protocol_log.js";
import { addStepLatency, logServer, runWithMcpRequestId } from "./logger.js";
import { runWithAuth, setRequestAuth, clearRequestAuth } from "./request-context.js";
// Pelaris 1.4 B2a lane C, C6: DCR guard, client address, return hook, connector_use.
import { DEFAULT_OAUTH_CF_BASE, mountConnectorRoutes, runConnectorReturnStep } from "./connector/routes.js";
import { runWithConnectorFacts } from "./connector/connector_use.js";

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
// get_generation_status (src/tools/user/get_generation_status.ts) is
// RETIRED (GL-I43, Spring Tide 1.2.0, 17/09/2026) and deliberately no
// longer imported here. See the "User coaching tools" comment further
// down, right above its former registration call site.
import { registerResolveExerciseIds } from "./tools/user/resolve_exercise_ids.js";

// User write tools (OAuth-scoped — PEL-69)
// generate_weekly_plan (src/tools/user/generate_weekly_plan.ts) is RETIRED
// (GL-I16, Spring Tide 1.2.0, 16/09/2026) and deliberately no longer
// imported here — see the "User write tools" comment further down, right
// above its former registration call site.
import { registerGenerateProgram } from "./tools/user/generate_program.js";
import { registerCompleteIntake } from "./tools/user/complete_intake.js";
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
import { registerListGoals } from "./tools/user/list_goals.js";
import { registerManageProgram } from "./tools/user/manage_program.js";
import { registerGetProgramStatus } from "./tools/user/get_program_status.js";
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
// CORS before body parsing so OPTIONS preflights short-circuit cleanly.
app.use(corsMiddleware);
app.use(express.json());

// Protocol-level request log: one allow-listed line per /mcp
// request, written once on finish or close, so 401s, 405s and aborted requests are seen too.
app.use("/mcp", mcpProtocolLog);

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
const OAUTH_CF_BASE = process.env.OAUTH_CF_BASE || DEFAULT_OAUTH_CF_BASE;

// POST /register, POST /token and POST /revoke live in connector/routes.ts (B2a fix
// pass, CR-15: they are testable there with Firestore, the limiter, the bridge
// and the function stubbed). /authorize stays here: it is a plain redirect.
mountConnectorRoutes(app);

// GET /authorize → redirect to OAuth CF authorization endpoint
app.get("/authorize", (req, res) => {
  const qs = new URLSearchParams(req.query as Record<string, string>).toString();
  res.redirect(302, `${OAUTH_CF_BASE}/oauth/authorize?${qs}`);
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
      "health:read", "health:write", "coach:read", "offline_access",
    ],
    token_endpoint_auth_methods_supported: ["none"],
  });
});

// RFC 9728 — Protected Resource Metadata
// Both the root and path-aware documents advertise the SAME canonical resource
// (`${MCP_SERVER_URL}/mcp`). The only protected endpoint is POST /mcp, and the
// token `aud` is bound to that exact string — advertising the bare origin here
// (which also equals the issuer) would conflate the AS and RS identifiers and
// weaken the audience binding (RFC 8707). Keep both consistent.
app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: `${MCP_SERVER_URL}/mcp`,
    authorization_servers: [MCP_SERVER_URL],
    scopes_supported: [
      "profile:read", "training:read", "training:write",
      "health:read", "health:write", "coach:read", "offline_access",
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
      "health:read", "health:write", "coach:read", "offline_access",
    ],
    bearer_methods_supported: ["header"],
  });
});

// MCP endpoint — stateless mode (fresh server per request)
app.post("/mcp", timedStep("auth", verifyBearerToken), timedStep("rate_limit", rateLimiter), async (req: McpAuthenticatedRequest, res) => {
  // The protocol-log middleware's id, so this request's lines join its mcp_request line.
  const requestId = mcpRequestIdFor(res);
  const authContext = req.mcpAuth || null;

  // B2a C6 (d), (h): the connector facts for logToolCall (FL-9 1.6); the return check itself
  // runs inside the try below (B2a fix pass, CR-10).
  const connector = req.isAdminAuth ? undefined : req.connectorAccess;
  const connectorFacts = connector ?
    { profileId: connector.profileId, clientClass: connector.assistantClass ?? "unknown" as const } :
    null;

  // PEL-122: Use AsyncLocalStorage for concurrency-safe per-request auth context
  const steps = mcpStepsFor(res);
  await runWithMcpRequestId(requestId, () => runWithConnectorFacts(connectorFacts, () => runWithAuth(authContext, async () => {
  try {
    // B2a C6 (h), CR-10: B1R's return check before a direct tool. It never throws and is
    // awaited here, inside the handler's try, so a malformed bridge reply can never
    // become an unhandled rejection that ends the process.
    const returnCheckStarted = Date.now();
    await runConnectorReturnStep(req);
    addStepLatency("return_check", Date.now() - returnCheckStarted, steps);

    const server = new McpServer({
      name: "pelaris-firebase-mcp",
      version: VERSION,
    }, {
      // Server-level framing the client reads. Establishes Pelaris as a
      // fitness/wellness coaching tool (general information, NOT medical advice)
      // and discloses AI-generated output — connector-cert requirement (no
      // tailored medical advice + AI disclosure).
      instructions:
        "Pelaris provides AI-assisted fitness and training coaching — general " +
        "training information and personalised training plans, not medical, " +
        "diagnostic, or therapeutic advice. Do not diagnose or treat. If a user " +
        "reports pain, injury, or health symptoms, recommend they consult a " +
        "licensed professional. All coaching output is AI-generated. " +
        // B2a C6 (f), FL-3 §3.6 (★★ semantic review): one guidance line; the
        // model chooses the words. Reworded 22/10/2026 (connector rev 2.1, M3, forced by
        // Brad's 20/10 ruling, BRAD_RETURN #46): programs are built in Pelaris, never in the
        // chat, so the line no longer promises a plan "right here in the conversation". It
        // asks the intake here, hands over the link generate_program returns, and keeps the
        // offer of a first session today. A wording change, not a new behaviour: flag for the
        // FL-3 owner and the B2a reviewer.
        "When get_onboarding_status shows setup is not finished (its next_step is " +
        "complete_intake or generate_program), offer to get the person started: if " +
        "their intake is not done, ask the intake questions here and save the answers " +
        "with complete_intake; then call generate_program for the link that opens " +
        "their program in Pelaris, and offer to do their first session today. " +
        "Programs are built in Pelaris, not in this chat; plan single sessions or a " +
        "week at a time here. " +
        "When it reports preferred_units, use them and do not ask for units again. " +
        "Offer this once; if the person declines, carry on with what they asked.",
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
    // get_generation_status (src/tools/user/get_generation_status.ts) is
    // RETIRED (GL-I43, Spring Tide 1.2.0, 17/09/2026): no registered tool
    // has produced a job id for it to poll since generate_weekly_plan was
    // retired (GL-I16), so every call returned nothing useful. No longer
    // registered. The module stays at
    // src/tools/user/get_generation_status.ts, unregistered, for history.
    // Exercise-id preflight: read tool that teaches the write vocabulary
    // (resolve names -> canonical exerciseId -> pass to write tools).
    registerResolveExerciseIds(server);

    // ─── User write tools (OAuth-scoped — PEL-69) ────────────────
    // generate_program is a reply-only tool since connector rev 2.1 (22/10/2026, Brad's
    // ruling BRAD_RETURN #46): it builds nothing here and answers with the link that opens
    // Pelaris at the right place (building their program, or the one they hold); the program
    // itself is built in the app. It stays listed so an assistant that is asked for a program
    // explains instead of failing. (Its former build-and-enrol path, Unified Uplift G3 / C-3,
    // is gone from this server; the long-build limiter is kept for a future ticket.)
    // generate_weekly_plan is RETIRED (GL-I16, Spring Tide 1.2.0, 16/09/2026): its
    // /generateProgramHttp endpoint is gone in this release, so the tool would now 404 on
    // every call. No longer registered: the module stays at
    // src/tools/user/generate_weekly_plan.ts, unregistered, for history.
    registerCompleteIntake(server);
    registerGenerateProgram(server);
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
    // Read-only companion to manage_goals (cert polish — DESIGN.md Item 3).
    // manage_goals{action:"list"} remains as a deprecated alias to this logic.
    registerListGoals(server);
    registerManageProgram(server);
    registerGetProgramStatus(server);
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
      // Return a single application/json JSON-RPC response instead of an SSE
      // stream. This server does no server->client streaming (GET/DELETE=405),
      // and a Fastly CDN fronts api.pelaris.io that buffers text/event-stream,
      // which can stall a hosted connector's session setup ("unable to
      // connect"). Plain JSON passes the CDN cleanly. Spec-valid: the server
      // MAY return either content type on POST /mcp.
      enableJsonResponse: true,
    });

    // Release the per-request server + transport when the response finishes,
    // so a load-testing connector can't leak handles.
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    logServer("MCP request error", { requestId, error: (error as Error).message });
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
  })), steps); // end runWithAuth, runWithConnectorFacts, runWithMcpRequestId
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
