/**
 * MCP Tool Validation Script
 *
 * Calls each MCP tool, then queries Firestore directly,
 * and compares the responses to ensure data accuracy.
 *
 * Usage: node test_validate.js [profileId] [jwtSecret]
 * Defaults to the review account if no args provided.
 */

const crypto = require("crypto");
const https = require("https");

const PROFILE_ID = process.argv[2] || "rcLsUAMazWkFAUzuUcvz";
const JWT_SECRET = process.argv[3] || "23d9e5b339c600f98c6ef50e599e6ccc764bb8f5ccda2cf7bdcf92f22ebfc13c";
const MCP_URL = "https://api.pelaris.io/mcp";

// Initialize Firebase Admin
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId: "wayfinder-ai-fitness" });
const db = admin.firestore();

// Generate JWT
function generateToken() {
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify({
    sub: "validate-test",
    scope: "profile:read training:read training:write health:read health:write coach:read",
    platform: "direct",
    profile_id: PROFILE_ID,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString("base64url");
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(h + "." + p, "utf8").digest("base64url");
  return h + "." + p + "." + sig;
}

// Call MCP tool
function callTool(toolName, args = {}) {
  return new Promise((resolve, reject) => {
    const token = generateToken();
    const body = JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: toolName, arguments: args },
    });
    const url = new URL(MCP_URL);
    const opts = {
      hostname: url.hostname, path: url.pathname, method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": `Bearer ${token}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try {
          // Parse SSE response
          const match = data.match(/"text":"(.+?)(?:"\}\])/s);
          if (match) {
            const text = match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
            resolve(JSON.parse(text));
          } else {
            resolve({ _raw: data });
          }
        } catch (e) {
          resolve({ _raw: data, _error: e.message });
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(body);
    req.end();
  });
}

// Validation tests
const results = [];
function assert(testId, description, condition, details = "") {
  const status = condition ? "PASS" : "FAIL";
  results.push({ testId, description, status, details });
  const icon = condition ? "✓" : "✗";
  console.log(`  ${icon} ${testId}: ${description}${details ? " — " + details : ""}`);
}

async function validate() {
  console.log(`\n=== MCP VALIDATION SUITE ===`);
  console.log(`Profile: ${PROFILE_ID}`);
  console.log(`URL: ${MCP_URL}\n`);

  // ── get_training_overview ──────────────────────────────
  console.log("── get_training_overview ──");
  const ctx = await callTool("get_training_overview");
  const profileDoc = await db.doc(`profiles/${PROFILE_ID}`).get();
  const pd = profileDoc.data();

  assert("CTX-01", "Sport matches Firestore",
    ctx.profile?.sport === (pd.sport || pd.training_context?.experience_level ? pd.sport : null),
    `MCP: ${ctx.profile?.sport}, DB: ${pd.sport}`);

  assert("CTX-02", "Equipment count matches",
    (ctx.profile?.equipment || []).length === (pd.training_context?.equipment || pd.equipment || []).length,
    `MCP: ${(ctx.profile?.equipment || []).length}, DB: ${(pd.training_context?.equipment || pd.equipment || []).length}`);

  assert("CTX-03", "Experience level present",
    !!ctx.profile?.experienceLevel,
    `Value: ${ctx.profile?.experienceLevel}`);

  assert("CTX-04", "Has active programs",
    (ctx.activePrograms || []).length > 0,
    `Count: ${(ctx.activePrograms || []).length}`);

  assert("CTX-05", "Has recent sessions",
    (ctx.recentSessions || []).length > 0,
    `Count: ${(ctx.recentSessions || []).length}`);

  assert("CTX-06", "Goal summary present",
    !!ctx.goalSummary,
    `Value: ${(ctx.goalSummary || "").substring(0, 50)}`);

  assert("CTX-07", "Benchmark summary present",
    !!ctx.benchmarkSummary,
    `Value: ${(ctx.benchmarkSummary || "").substring(0, 50)}`);

  // ── get_active_program ──────────────────────────────
  console.log("\n── get_active_program ──");
  const prog = await callTool("get_active_program");
  const queuesSnap = await db.collection(`profiles/${PROFILE_ID}/queues`).limit(5).get();

  assert("PROG-01", "Program count matches Firestore queues",
    (prog.programs || []).length === queuesSnap.size,
    `MCP: ${(prog.programs || []).length}, DB: ${queuesSnap.size}`);

  if ((prog.programs || []).length > 0) {
    const p = prog.programs[0];
    const q = queuesSnap.docs[0].data();
    assert("PROG-02", "Program title matches",
      p.title === q.title,
      `MCP: ${p.title}, DB: ${q.title}`);

    assert("PROG-03", "Methodology matches",
      p.methodologyId === q.methodology_id,
      `MCP: ${p.methodologyId}, DB: ${q.methodology_id}`);

    assert("PROG-04", "Total sessions matches",
      p.totalSessions === (q.sessions || []).length,
      `MCP: ${p.totalSessions}, DB: ${(q.sessions || []).length}`);

    assert("PROG-05", "Has weekly overviews",
      !!p.weeklyOverviews,
      `Keys: ${Object.keys(p.weeklyOverviews || {}).join(",")}`);

    assert("PROG-06", "Has current phase",
      !!p.currentPhase,
      `Phase: ${p.currentPhase?.phase}`);
  }

  // ── get_benchmarks ──────────────────────────────
  console.log("\n── get_benchmarks ──");
  const bench = await callTool("get_benchmarks");
  const benchSnap = await db.collection(`profiles/${PROFILE_ID}/benchmarks`).get();

  assert("BENCH-01", "Benchmark count matches Firestore",
    (bench.benchmarks || []).length === benchSnap.size,
    `MCP: ${(bench.benchmarks || []).length}, DB: ${benchSnap.size}`);

  if (benchSnap.size > 0) {
    const dbBench = benchSnap.docs[0].data();
    const mcpBench = (bench.benchmarks || []).find(b => b.name === dbBench.name);
    if (mcpBench) {
      assert("BENCH-02", "Benchmark value matches",
        mcpBench.currentValue === dbBench.current_value,
        `MCP: ${mcpBench.currentValue}, DB: ${dbBench.current_value}`);
    }
  }

  // ── get_onboarding_status ──────────────────────────────
  console.log("\n── get_onboarding_status ──");
  const onboard = await callTool("get_onboarding_status");

  assert("ONBOARD-01", "Has sport",
    onboard.hasSport === true,
    `Value: ${onboard.hasSport}`);

  assert("ONBOARD-02", "Has program",
    onboard.hasProgram === true,
    `Value: ${onboard.hasProgram}`);

  assert("ONBOARD-03", "Has completed intake",
    onboard.hasCompletedIntake === true,
    `Value: ${onboard.hasCompletedIntake}`);

  // ── get_coach_insight ──────────────────────────────
  console.log("\n── get_coach_insight ──");
  const insight = await callTool("get_coach_insight");

  assert("INSIGHT-01", "Returns insights",
    (insight.insights || []).length > 0,
    `Count: ${(insight.insights || []).length}`);

  // ── search_training_resources ──────────────────────────────
  console.log("\n── search_training_resources ──");
  const search = await callTool("search_training_resources", { query: "strength training" });

  assert("SEARCH-01", "Returns results",
    (search.results || []).length > 0,
    `Count: ${(search.results || []).length}`);

  if ((search.results || []).length > 0) {
    assert("SEARCH-02", "Results have title",
      !!search.results[0].title,
      `Title: ${search.results[0].title}`);

    assert("SEARCH-03", "Results have URL",
      !!search.results[0].url,
      `URL: ${(search.results[0].url || "").substring(0, 50)}`);
  }

  // ── get_body_analysis ──────────────────────────────
  console.log("\n── get_body_analysis ──");
  const body = await callTool("get_body_analysis");
  // May be empty for review account — just check no error
  assert("BODY-01", "No error returned",
    !body._error && !body.isError,
    body._error || "OK");

  // ── Summary ──────────────────────────────
  console.log("\n══════════════════════════════");
  console.log("  VALIDATION SUMMARY");
  console.log("══════════════════════════════");
  const pass = results.filter(r => r.status === "PASS").length;
  const fail = results.filter(r => r.status === "FAIL").length;
  console.log(`  Total: ${results.length}`);
  console.log(`  PASS:  ${pass}`);
  console.log(`  FAIL:  ${fail}`);
  if (fail > 0) {
    console.log("\n  FAILURES:");
    results.filter(r => r.status === "FAIL").forEach(r => {
      console.log(`    ${r.testId}: ${r.description} — ${r.details}`);
    });
  }
  console.log("══════════════════════════════\n");
}

validate().then(() => process.exit(0)).catch(e => { console.error("Fatal:", e.message); process.exit(1); });
