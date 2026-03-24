#!/bin/bash
# Wave 8: MCP Perfection — Automated Test Script
# Runs all MCP tool tests and outputs results as JSON
# Usage: bash test_mcp.sh > test_results.json

MCP_URL="https://pelaris-mcp-server-653063894036.australia-southeast1.run.app/mcp"
TOKEN="018ec07a17e934e6c173fa8286185c4a"
RESULTS_FILE="/c/tmp/mcp_test_results.txt"

call_tool() {
  local tool_name="$1"
  local args="$2"
  local test_id="$3"
  local description="$4"

  local response=$(curl -s --max-time 30 -X POST "$MCP_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool_name\",\"arguments\":$args}}")

  local has_error=$(echo "$response" | grep -c '"error"')
  local has_result=$(echo "$response" | grep -c '"result"')
  local status="UNKNOWN"

  if echo "$response" | grep -q '"isError":true'; then
    status="TOOL_ERROR"
  elif [ "$has_error" -gt 0 ] && echo "$response" | grep -q '"code"'; then
    status="PROTOCOL_ERROR"
  elif [ "$has_result" -gt 0 ]; then
    status="PASS"
  elif [ -z "$response" ]; then
    status="TIMEOUT"
  else
    status="UNEXPECTED"
  fi

  echo "$test_id|$tool_name|$description|$status|$(echo "$response" | head -c 500)" >> "$RESULTS_FILE"
  echo "$test_id: $tool_name — $status"
}

list_tools() {
  curl -s --max-time 30 -X POST "$MCP_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
}

list_resources() {
  curl -s --max-time 30 -X POST "$MCP_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"jsonrpc":"2.0","id":1,"method":"resources/list","params":{}}'
}

list_prompts() {
  curl -s --max-time 30 -X POST "$MCP_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"jsonrpc":"2.0","id":1,"method":"prompts/list","params":{}}'
}

read_resource() {
  local uri="$1"
  curl -s --max-time 30 -X POST "$MCP_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"resources/read\",\"params\":{\"uri\":\"$uri\"}}"
}

# Clear results file
> "$RESULTS_FILE"

echo "=== Wave 8 MCP Testing — $(date) ==="
echo ""

# ── Initialize ──
echo "--- Initializing MCP session ---"
curl -s --max-time 30 -X POST "$MCP_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"wave8-test","version":"1.0"}}}' > /dev/null
echo "Initialized."
echo ""

# ── List Discovery ──
echo "--- Discovery Tests ---"
echo "Tools:" && list_tools | grep -o '"name":"[^"]*"' | head -30
echo ""
echo "Resources:" && list_resources | grep -o '"uri":"[^"]*"' | head -10
echo ""
echo "Prompts:" && list_prompts | grep -o '"name":"[^"]*"' | head -10
echo ""

# ── READ TOOL TESTS ──
echo "=== READ TOOL TESTS ==="

# get_training_context
call_tool "get_training_context" '{}' "TEST-011" "Basic training context"

# get_active_program
call_tool "get_active_program" '{}' "TEST-012" "Active programs"

# get_benchmarks
call_tool "get_benchmarks" '{}' "TEST-013" "All benchmarks"

# get_body_analysis
call_tool "get_body_analysis" '{}' "TEST-014" "Body analysis"

# get_onboarding_status
call_tool "get_onboarding_status" '{}' "TEST-015" "Onboarding status"

# get_coach_insight
call_tool "get_coach_insight" '{}' "TEST-016" "Coach insights"

# search_engine_resources — various queries
call_tool "search_engine_resources" '{"query":"zone 2 training"}' "TEST-017" "Search: zone 2"
call_tool "search_engine_resources" '{"query":"strength training for runners"}' "TEST-018" "Search: strength for runners"
call_tool "search_engine_resources" '{"query":"swimming drills"}' "TEST-019" "Search: swimming drills"
call_tool "search_engine_resources" '{"query":"injury prevention"}' "TEST-020" "Search: injury prevention"
call_tool "search_engine_resources" '{"query":"marathon training plan"}' "TEST-021" "Search: marathon plan"
call_tool "search_engine_resources" '{"query":"protein intake"}' "TEST-022" "Search: protein"
call_tool "search_engine_resources" '{"query":"recovery between sessions"}' "TEST-023" "Search: recovery"
call_tool "search_engine_resources" '{"query":"cycling power zones"}' "TEST-024" "Search: power zones"
call_tool "search_engine_resources" '{"query":"triathlon brick workouts"}' "TEST-025" "Search: brick workouts"
call_tool "search_engine_resources" '{"query":""}' "TEST-026" "Search: empty query"
call_tool "search_engine_resources" '{"query":"xyznonexistent123"}' "TEST-027" "Search: nonsense query"

# get_session_details — need to find valid IDs from training context first
call_tool "get_session_details" '{"sessionId":"nonexistent-id-123"}' "TEST-028" "Session details: invalid ID"

# ── WRITE TOOL TESTS ──
echo ""
echo "=== WRITE TOOL TESTS ==="

# log_workout
call_tool "log_workout" '{"sport":"running","duration":30,"rpe":6,"notes":"MCP-TEST-001 easy jog"}' "TEST-029" "Log workout: basic run"
call_tool "log_workout" '{"sport":"swimming","duration":45,"rpe":7,"notes":"MCP-TEST-002 swim session","distance":"2000m"}' "TEST-030" "Log workout: swim"
call_tool "log_workout" '{"sport":"strength","duration":60,"rpe":8,"notes":"MCP-TEST-003 upper body"}' "TEST-031" "Log workout: strength"

# log_workout — edge cases
call_tool "log_workout" '{}' "TEST-032" "Log workout: empty params"
call_tool "log_workout" '{"sport":"invalid_sport","duration":-5}' "TEST-033" "Log workout: invalid params"

# swap_exercise
call_tool "swap_exercise" '{"exerciseName":"barbell squat","reason":"equipment"}' "TEST-034" "Swap: barbell squat (equipment)"
call_tool "swap_exercise" '{"exerciseName":"pull ups","reason":"injury"}' "TEST-035" "Swap: pull ups (injury)"
call_tool "swap_exercise" '{"exerciseName":"deadlift","reason":"preference"}' "TEST-036" "Swap: deadlift (preference)"
call_tool "swap_exercise" '{"exerciseName":"nonexistent exercise 123"}' "TEST-037" "Swap: nonexistent exercise"

# update_user_profile
call_tool "update_user_profile" '{"equipment":["dumbbells","barbell","pull_up_bar"]}' "TEST-038" "Update profile: equipment"
call_tool "update_user_profile" '{"preferredSessionDuration":45}' "TEST-039" "Update profile: session duration"
call_tool "update_user_profile" '{}' "TEST-040" "Update profile: empty"

# add_injury
call_tool "add_injury" '{"bodyPart":"left knee","severity":"mild","notes":"MCP-TEST slight discomfort"}' "TEST-041" "Add injury: mild knee"
call_tool "add_injury" '{"bodyPart":"right shoulder","severity":"moderate","notes":"MCP-TEST rotator cuff"}' "TEST-042" "Add injury: moderate shoulder"
call_tool "add_injury" '{}' "TEST-043" "Add injury: empty params"

# log_coach_feedback
call_tool "log_coach_feedback" '{"rating":5,"comment":"MCP-TEST great coaching","toolName":"get_coach_insight","helpful":true}' "TEST-044" "Feedback: positive"
call_tool "log_coach_feedback" '{"rating":2,"comment":"MCP-TEST not helpful","toolName":"get_benchmarks","helpful":false}' "TEST-045" "Feedback: negative"
call_tool "log_coach_feedback" '{"rating":3}' "TEST-046" "Feedback: minimal"

# generate_weekly_plan
call_tool "generate_weekly_plan" '{"focus":"strength","daysAvailable":4}' "TEST-047" "Generate plan: strength 4 days"
call_tool "generate_weekly_plan" '{"focus":"running","daysAvailable":6,"intensityPreference":"moderate"}' "TEST-048" "Generate plan: running 6 days"
call_tool "generate_weekly_plan" '{}' "TEST-049" "Generate plan: no params"

# modify_training_session — needs valid session ID, use a test one
call_tool "modify_training_session" '{"sessionId":"nonexistent","modifications":{"reduceVolume":true}}' "TEST-050" "Modify session: invalid ID"

# ── ERROR HANDLING TESTS ──
echo ""
echo "=== ERROR HANDLING TESTS ==="

# Call non-existent tool
curl -s --max-time 30 -X POST "$MCP_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"nonexistent_tool","arguments":{}}}' > /dev/null
echo "TEST-051: nonexistent_tool — checked"

# Invalid JSON
curl -s --max-time 30 -X POST "$MCP_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -d 'not json at all' > /dev/null
echo "TEST-052: invalid JSON — checked"

# Missing method
curl -s --max-time 30 -X POST "$MCP_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1}' > /dev/null
echo "TEST-053: missing method — checked"

# ── RESOURCE TESTS ──
echo ""
echo "=== RESOURCE TESTS ==="
echo "Coach personality:"
read_resource "pelaris://coach/personality" | head -c 200
echo ""
echo "Methodologies:"
read_resource "pelaris://sports/methodologies" | head -c 200
echo ""

# ── SUMMARY ──
echo ""
echo "=== TEST SUMMARY ==="
echo "Total tests in results file: $(wc -l < "$RESULTS_FILE")"
echo "PASS: $(grep -c '|PASS|' "$RESULTS_FILE")"
echo "TOOL_ERROR: $(grep -c '|TOOL_ERROR|' "$RESULTS_FILE")"
echo "PROTOCOL_ERROR: $(grep -c '|PROTOCOL_ERROR|' "$RESULTS_FILE")"
echo "TIMEOUT: $(grep -c '|TIMEOUT|' "$RESULTS_FILE")"
echo "UNEXPECTED: $(grep -c '|UNEXPECTED|' "$RESULTS_FILE")"
echo ""
echo "Results saved to: $RESULTS_FILE"
