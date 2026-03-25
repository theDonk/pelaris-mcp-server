#!/bin/bash
# Wave 8 Round 3 — Post-all-fixes comprehensive test
# Uses properly signed JWT token with correct profileId

MCP_URL="https://api.pelaris.io/mcp"

# Generate fresh JWT token (24hr expiry)
JWT_SECRET="23d9e5b339c600f98c6ef50e599e6ccc764bb8f5ccda2cf7bdcf92f22ebfc13c"
TOKEN=$(node -e "
const crypto = require('crypto');
const s = '$JWT_SECRET';
const h = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
const p = Buffer.from(JSON.stringify({sub:'round3-test',scope:'profile:read training:read training:write health:read health:write coach:read',platform:'direct',profile_id:'Pjf0Zo5Pmbm522g7Ry8X',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+86400})).toString('base64url');
const sig = crypto.createHmac('sha256',s).update(h+'.'+p,'utf8').digest('base64url');
process.stdout.write(h+'.'+p+'.'+sig);
")

RESULTS="/c/tmp/mcp_round3.txt"
> "$RESULTS"
PASS=0
FAIL=0

ct() {
  local t="$1" a="$2" i="$3" d="$4"
  local r=$(curl -s --max-time 30 -X POST "$MCP_URL" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Authorization: Bearer $TOKEN" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$t\",\"arguments\":$a}}")
  local s="PASS"
  echo "$r" | grep -q '"isError":true' && s="TOOL_ERROR"
  [ -z "$r" ] && s="TIMEOUT"
  echo "$i|$t|$d|$s" >> "$RESULTS"
  if [ "$s" = "PASS" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
  echo "$i: $t - $s"
}

echo "=== ROUND 3 — COMPREHENSIVE POST-FIX TEST $(date) ==="
echo "Token length: ${#TOKEN}"
echo ""

# ══════════════════════════════════════════════════════════════
# READ TOOLS (should all pass)
# ══════════════════════════════════════════════════════════════
echo "--- READ TOOLS ---"
ct get_training_context '{}' R3-001 "training context"
ct get_active_program '{}' R3-002 "active programs"
ct get_benchmarks '{}' R3-003 "benchmarks"
ct get_body_analysis '{}' R3-004 "body analysis"
ct get_onboarding_status '{}' R3-005 "onboarding"
ct get_coach_insight '{}' R3-006 "coach insight"

# Search - 20 varied queries
ct search_engine_resources '{"query":"zone 2 training"}' R3-007 "s:zone2"
ct search_engine_resources '{"query":"strength training"}' R3-008 "s:strength"
ct search_engine_resources '{"query":"recovery nutrition"}' R3-009 "s:nutrition"
ct search_engine_resources '{"query":"swim drills"}' R3-010 "s:swim"
ct search_engine_resources '{"query":"marathon preparation"}' R3-011 "s:marathon"
ct search_engine_resources '{"query":"cycling power"}' R3-012 "s:power"
ct search_engine_resources '{"query":"injury prevention"}' R3-013 "s:injury"
ct search_engine_resources '{"query":"sleep recovery"}' R3-014 "s:sleep"
ct search_engine_resources '{"query":"protein intake"}' R3-015 "s:protein"
ct search_engine_resources '{"query":"flexibility mobility"}' R3-016 "s:flex"
ct search_engine_resources '{"query":"HIIT workout"}' R3-017 "s:hiit"
ct search_engine_resources '{"query":"triathlon training"}' R3-018 "s:tri"
ct search_engine_resources '{"query":"overtraining"}' R3-019 "s:overtrain"
ct search_engine_resources '{"query":"warm up routine"}' R3-020 "s:warmup"
ct search_engine_resources '{"query":"progressive overload"}' R3-021 "s:overload"
ct search_engine_resources '{"query":"deload week"}' R3-022 "s:deload"
ct search_engine_resources '{"query":"RPE training"}' R3-023 "s:rpe"
ct search_engine_resources '{"query":"foam rolling"}' R3-024 "s:foam"
ct search_engine_resources '{"query":"creatine"}' R3-025 "s:creatine"
ct search_engine_resources '{"query":"VO2max"}' R3-026 "s:vo2max"

# Session details - invalid ID (expected TOOL_ERROR)
ct get_session_details '{"sessionId":"nonexistent"}' R3-027 "session:invalid"

# Consistency checks
ct get_training_context '{}' R3-028 "consist:ctx"
ct get_benchmarks '{}' R3-029 "consist:bench"
ct get_active_program '{}' R3-030 "consist:prog"

# ══════════════════════════════════════════════════════════════
# WRITE TOOLS
# ══════════════════════════════════════════════════════════════
echo ""
echo "--- WRITE TOOLS ---"

# Swap exercise (no sessionId)
ct swap_exercise '{"exerciseName":"barbell squat","reason":"equipment"}' R3-031 "swap:squat"
ct swap_exercise '{"exerciseName":"pull ups","reason":"injury"}' R3-032 "swap:pullup"
ct swap_exercise '{"exerciseName":"bench press"}' R3-033 "swap:bench"
ct swap_exercise '{"exerciseName":"deadlift","reason":"preference"}' R3-034 "swap:dead"
ct swap_exercise '{"exerciseName":"lat pulldown","reason":"equipment"}' R3-035 "swap:latpull"
ct swap_exercise '{"exerciseName":"burpees"}' R3-036 "swap:unknown"

# Add injury (natural language)
ct add_injury '{"bodyPart":"left knee","severity":"mild","notes":"R3-TEST"}' R3-037 "inj:leftknee"
ct add_injury '{"bodyPart":"shoulder","side":"right","severity":"moderate"}' R3-038 "inj:rshoulder"
ct add_injury '{"bodyPart":"lower back","severity":"mild"}' R3-039 "inj:lowerback"
ct add_injury '{"bodyPart":"ankle","severity":"mild"}' R3-040 "inj:ankle"
ct add_injury '{"bodyPart":"hamstring","side":"left","severity":"severe"}' R3-041 "inj:lhamstring"

# Log coach feedback (minimal params)
ct log_coach_feedback '{"rating":4}' R3-042 "fb:minimal"
ct log_coach_feedback '{"rating":5,"comment":"R3-TEST excellent"}' R3-043 "fb:comment"
ct log_coach_feedback '{"rating":2,"helpful":false}' R3-044 "fb:unhelpful"

# Update profile
ct update_user_profile '{}' R3-045 "prof:empty"
ct update_user_profile '{"equipment":["dumbbells","barbell","pull_up_bar"]}' R3-046 "prof:equip"
ct update_user_profile '{"preferredSessionDuration":60}' R3-047 "prof:duration"

# Log workouts (all sport types)
ct log_workout '{"sport":"running","duration":30,"rpe":6,"notes":"R3-TEST easy run"}' R3-048 "log:run"
ct log_workout '{"sport":"swimming","duration":45,"rpe":7,"notes":"R3-TEST swim"}' R3-049 "log:swim"
ct log_workout '{"sport":"strength","duration":60,"rpe":8,"notes":"R3-TEST strength"}' R3-050 "log:strength"
ct log_workout '{"sport":"cycling","duration":90,"rpe":7,"notes":"R3-TEST ride"}' R3-051 "log:cycle"
ct log_workout '{"sport":"other","duration":30,"rpe":4,"notes":"R3-TEST yoga"}' R3-052 "log:other"
ct log_workout '{"sport":"triathlon","duration":120,"rpe":8,"notes":"R3-TEST tri"}' R3-053 "log:tri"
ct log_workout '{"sport":"crossfit","duration":45,"rpe":9,"notes":"R3-TEST crossfit"}' R3-054 "log:crossfit"

# Generate weekly plan
ct generate_weekly_plan '{}' R3-055 "gen:empty"
ct generate_weekly_plan '{"focus":"strength","daysAvailable":4}' R3-056 "gen:strength4"

# Modify session (invalid ID - expected error)
ct modify_training_session '{"sessionId":"nonexistent","modifications":{"reduceVolume":true}}' R3-057 "mod:invalid"

# ══════════════════════════════════════════════════════════════
# EDGE CASES
# ══════════════════════════════════════════════════════════════
echo ""
echo "--- EDGE CASES ---"
ct search_engine_resources '{"query":""}' R3-058 "edge:empty-query"
ct search_engine_resources '{"query":"a"}' R3-059 "edge:single-char"
ct log_workout '{"sport":"running","duration":5,"rpe":2,"notes":"R3-TEST quick"}' R3-060 "edge:min-workout"
ct log_workout '{"sport":"strength","duration":180,"rpe":10,"notes":"R3-TEST max"}' R3-061 "edge:max-workout"
ct add_injury '{"bodyPart":"general","severity":"mild"}' R3-062 "edge:general-inj"
ct add_injury '{"bodyPart":"core","severity":"mild","notes":"R3-TEST"}' R3-063 "edge:core-inj"
ct swap_exercise '{"exerciseName":"plank"}' R3-064 "edge:plank-swap"
ct log_coach_feedback '{"rating":1}' R3-065 "edge:lowest-fb"
ct log_coach_feedback '{"rating":5}' R3-066 "edge:highest-fb"

# ══════════════════════════════════════════════════════════════
# PERSONA SCENARIOS
# ══════════════════════════════════════════════════════════════
echo ""
echo "--- PERSONA SCENARIOS ---"

# Beginner runner
ct search_engine_resources '{"query":"beginner running plan"}' R3-067 "persona:beginner1"
ct search_engine_resources '{"query":"running shoe selection"}' R3-068 "persona:beginner2"
ct log_workout '{"sport":"running","duration":20,"rpe":4,"notes":"R3-TEST walk-run intervals"}' R3-069 "persona:beginner-log"

# Advanced swimmer
ct search_engine_resources '{"query":"competitive swimming periodization"}' R3-070 "persona:swimmer1"
ct search_engine_resources '{"query":"USRPT swim training"}' R3-071 "persona:swimmer2"

# Injured cyclist
ct add_injury '{"bodyPart":"knee","side":"right","severity":"moderate","notes":"R3-TEST cycling overuse"}' R3-072 "persona:injured-log"
ct search_engine_resources '{"query":"knee pain cycling prevention"}' R3-073 "persona:injured-search"

# Triathlete race prep
ct search_engine_resources '{"query":"Ironman race day nutrition"}' R3-074 "persona:tri-race"
ct search_engine_resources '{"query":"transition practice tips"}' R3-075 "persona:tri-trans"

# ══════════════════════════════════════════════════════════════
# RESOURCES AND PROMPTS
# ══════════════════════════════════════════════════════════════
echo ""
echo "--- RESOURCES ---"

# List resources
echo "Resources:"
curl -s --max-time 15 -X POST "$MCP_URL" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Authorization: Bearer $TOKEN" -d '{"jsonrpc":"2.0","id":1,"method":"resources/list","params":{}}' 2>&1 | grep -o '"uri":"[^"]*"'

# Read coach personality (check for Pelaris branding)
echo ""
echo "Coach persona name:"
curl -s --max-time 15 -X POST "$MCP_URL" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Authorization: Bearer $TOKEN" -d '{"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"pelaris://coach/personality"}}' 2>&1 | grep -o '"personaName":"[^"]*"'

# List prompts
echo ""
echo "Prompts:"
curl -s --max-time 15 -X POST "$MCP_URL" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Authorization: Bearer $TOKEN" -d '{"jsonrpc":"2.0","id":1,"method":"prompts/list","params":{}}' 2>&1 | grep -o '"name":"[^"]*"'

# ══════════════════════════════════════════════════════════════
# TOOL LIST (verify no admin tools)
# ══════════════════════════════════════════════════════════════
echo ""
echo "--- TOOL LIST (should NOT include admin tools) ---"
TOOLS=$(curl -s --max-time 15 -X POST "$MCP_URL" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Authorization: Bearer $TOKEN" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' 2>&1 | grep -o '"name":"[^"]*"')
echo "$TOOLS"
echo ""
TOOL_COUNT=$(echo "$TOOLS" | wc -l)
echo "Tool count: $TOOL_COUNT (should be ~15, no admin tools)"

# Check for admin tools that should NOT be present
echo "$TOOLS" | grep -q "get_research" && echo "WARNING: admin tool get_research exposed!" || echo "OK: get_research hidden"
echo "$TOOLS" | grep -q "write_research" && echo "WARNING: admin tool write_research exposed!" || echo "OK: write_research hidden"
echo "$TOOLS" | grep -q "list_pipeline" && echo "WARNING: admin tool list_pipeline exposed!" || echo "OK: list_pipeline hidden"

# ══════════════════════════════════════════════════════════════
# VERSION CHECK
# ══════════════════════════════════════════════════════════════
echo ""
echo "--- VERSION ---"
curl -s "https://api.pelaris.io/health"

# ══════════════════════════════════════════════════════════════
# SUMMARY
# ══════════════════════════════════════════════════════════════
echo ""
echo ""
echo "════════════════════════════════════════"
echo "  ROUND 3 FINAL SUMMARY"
echo "════════════════════════════════════════"
TOTAL=$(wc -l < "$RESULTS")
PASS_COUNT=$(grep -c 'PASS' "$RESULTS" || echo 0)
ERR_COUNT=$(grep -c 'TOOL_ERROR' "$RESULTS" || echo 0)
TO_COUNT=$(grep -c 'TIMEOUT' "$RESULTS" || echo 0)
echo "Total tests: $TOTAL"
echo "PASS: $PASS_COUNT"
echo "TOOL_ERROR: $ERR_COUNT"
echo "TIMEOUT: $TO_COUNT"
echo ""
if [ "$ERR_COUNT" -gt 0 ]; then
  echo "FAILURES:"
  grep 'TOOL_ERROR' "$RESULTS"
fi
echo "════════════════════════════════════════"
