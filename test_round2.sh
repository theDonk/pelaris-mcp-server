#!/bin/bash
MCP_URL="https://api.pelaris.io/mcp"
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVzZXItcHNldWRvIiwic2NvcGUiOiJwcm9maWxlOnJlYWQgdHJhaW5pbmc6cmVhZCB0cmFpbmluZzp3cml0ZSBoZWFsdGg6cmVhZCBoZWFsdGg6d3JpdGUgY29hY2g6cmVhZCIsInBsYXRmb3JtIjoiZGlyZWN0IiwicHJvZmlsZV9pZCI6IlBqZjBabzVQbWJtNTIyZzdSeThYIiwiaWF0IjoxNzc0Mzg0OTAwLCJleHAiOjE3NzQ0NzEzMDB9.Uw7IPvD7LhuMuiDqiDHzXaup7YayCUviVJh7abAA0sA"
RESULTS="/c/tmp/mcp_round2.txt"
> "$RESULTS"

ct() {
  local t="$1" a="$2" i="$3" d="$4"
  local r=$(curl -s --max-time 30 -X POST "$MCP_URL" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Authorization: Bearer $TOKEN" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$t\",\"arguments\":$a}}")
  local s="PASS"
  echo "$r" | grep -q '"isError":true' && s="TOOL_ERROR"
  [ -z "$r" ] && s="TIMEOUT"
  echo "$i|$t|$d|$s" >> "$RESULTS"
  echo "$i: $t - $s"
}

echo "=== ROUND 2 $(date) ==="

# Read tools
ct get_training_context '{}' R01 "context"
ct get_active_program '{}' R02 "programs"
ct get_benchmarks '{}' R03 "benchmarks"
ct get_body_analysis '{}' R04 "body"
ct get_onboarding_status '{}' R05 "onboard"
ct get_coach_insight '{}' R06 "insight"
ct search_engine_resources '{"query":"zone 2 training"}' R07 "search1"
ct search_engine_resources '{"query":"strength for runners"}' R08 "search2"
ct search_engine_resources '{"query":"recovery nutrition"}' R09 "search3"
ct search_engine_resources '{"query":"swim technique"}' R10 "search4"
ct get_session_details '{"sessionId":"nonexistent"}' R11 "session-bad"

# Swap exercise
ct swap_exercise '{"exerciseName":"barbell squat","reason":"equipment"}' R12 "swap1"
ct swap_exercise '{"exerciseName":"pull ups","reason":"injury"}' R13 "swap2"
ct swap_exercise '{"exerciseName":"bench press"}' R14 "swap3"
ct swap_exercise '{"exerciseName":"deadlift","reason":"preference"}' R15 "swap4"
ct swap_exercise '{"exerciseName":"lat pulldown","reason":"equipment"}' R16 "swap5"
ct swap_exercise '{"exerciseName":"leg press","reason":"equipment"}' R17 "swap6"
ct swap_exercise '{"exerciseName":"hip thrust","reason":"preference"}' R18 "swap7"
ct swap_exercise '{"exerciseName":"plank"}' R19 "swap8"
ct swap_exercise '{"exerciseName":"burpees"}' R20 "swap-unknown"

# Injury
ct add_injury '{"bodyPart":"left knee","severity":"mild","notes":"R2-TEST"}' R21 "inj1"
ct add_injury '{"bodyPart":"shoulder","side":"right","severity":"moderate"}' R22 "inj2"
ct add_injury '{"bodyPart":"lower back","severity":"mild"}' R23 "inj3"
ct add_injury '{"bodyPart":"ankle","severity":"mild","notes":"R2-TEST sprain"}' R24 "inj4"
ct add_injury '{"bodyPart":"hamstring","side":"right","severity":"severe"}' R25 "inj5"
ct add_injury '{"bodyPart":"core","severity":"mild"}' R26 "inj6"
ct add_injury '{"bodyPart":"wrist","severity":"mild"}' R27 "inj7"

# Feedback
ct log_coach_feedback '{"rating":1}' R28 "fb1"
ct log_coach_feedback '{"rating":3,"comment":"R2-TEST ok"}' R29 "fb2"
ct log_coach_feedback '{"rating":5,"helpful":true}' R30 "fb3"
ct log_coach_feedback '{"rating":4}' R31 "fb4"

# Profile
ct update_user_profile '{}' R32 "prof-empty"
ct update_user_profile '{"equipment":["dumbbells","barbell"]}' R33 "prof-equip"
ct update_user_profile '{"preferredSessionDuration":45}' R34 "prof-dur"

# Log workouts
ct log_workout '{"sport":"running","duration":30,"rpe":6,"notes":"R2-TEST run"}' R35 "log-run"
ct log_workout '{"sport":"swimming","duration":45,"rpe":7,"notes":"R2-TEST swim"}' R36 "log-swim"
ct log_workout '{"sport":"strength","duration":60,"rpe":8,"notes":"R2-TEST lift"}' R37 "log-str"
ct log_workout '{"sport":"cycling","duration":90,"rpe":7,"notes":"R2-TEST ride"}' R38 "log-cyc"
ct log_workout '{"sport":"other","duration":30,"rpe":4,"notes":"R2-TEST yoga"}' R39 "log-yoga"
ct log_workout '{"sport":"running","duration":15,"rpe":6,"notes":"R2-TEST brick"}' R40 "log-brick"
ct log_workout '{"sport":"running","duration":60,"rpe":8,"notes":"R2-TEST tempo"}' R41 "log-tempo"
ct log_workout '{"sport":"strength","duration":50,"rpe":7,"notes":"R2-TEST push"}' R42 "log-push"

# More searches
ct search_engine_resources '{"query":"beginner running program"}' R43 "s-beginner"
ct search_engine_resources '{"query":"open water swimming"}' R44 "s-ow"
ct search_engine_resources '{"query":"cycling power zones"}' R45 "s-power"
ct search_engine_resources '{"query":"triathlon taper"}' R46 "s-taper"
ct search_engine_resources '{"query":"strength plateau"}' R47 "s-plateau"
ct search_engine_resources '{"query":"sleep recovery"}' R48 "s-sleep"
ct search_engine_resources '{"query":"hydration exercise"}' R49 "s-hydrate"
ct search_engine_resources '{"query":"mental toughness"}' R50 "s-mental"
ct search_engine_resources '{"query":"cross training"}' R51 "s-cross"
ct search_engine_resources '{"query":"RPE scale"}' R52 "s-rpe"
ct search_engine_resources '{"query":"stretching warmup"}' R53 "s-stretch"
ct search_engine_resources '{"query":"rest day importance"}' R54 "s-rest"
ct search_engine_resources '{"query":"DOMS soreness"}' R55 "s-doms"
ct search_engine_resources '{"query":"HIIT cardio"}' R56 "s-hiit"
ct search_engine_resources '{"query":"creatine athletes"}' R57 "s-creat"
ct search_engine_resources '{"query":"periodization"}' R58 "s-period"
ct search_engine_resources '{"query":"VO2max training"}' R59 "s-vo2"
ct search_engine_resources '{"query":"foam rolling"}' R60 "s-foam"
ct search_engine_resources '{"query":"carb loading race"}' R61 "s-carb"
ct search_engine_resources '{"query":"mobility flexibility"}' R62 "s-mobil"
ct search_engine_resources '{"query":"training during illness"}' R63 "s-illness"
ct search_engine_resources '{"query":"deload week"}' R64 "s-deload"
ct search_engine_resources '{"query":"overtraining signs"}' R65 "s-overtrain"
ct search_engine_resources '{"query":"half marathon plan"}' R66 "s-half"
ct search_engine_resources '{"query":"FTP test cycling"}' R67 "s-ftp"
ct search_engine_resources '{"query":"ankle rehab exercises"}' R68 "s-ankle"
ct search_engine_resources '{"query":"progressive overload"}' R69 "s-overload"
ct search_engine_resources '{"query":"speed improvement"}' R70 "s-speed"

# Consistency
ct get_training_context '{}' R71 "consist1"
ct get_benchmarks '{}' R72 "consist2"
ct get_active_program '{}' R73 "consist3"
ct get_coach_insight '{}' R74 "consist4"
ct get_onboarding_status '{}' R75 "consist5"

echo ""
echo "=== ROUND 2 SUMMARY ==="
TOTAL=$(wc -l < "$RESULTS")
PASS=$(grep -c 'PASS' "$RESULTS" || echo 0)
ERR=$(grep -c 'TOOL_ERROR' "$RESULTS" || echo 0)
echo "Total: $TOTAL"
echo "PASS: $PASS"
echo "TOOL_ERROR: $ERR"
if [ "$ERR" -gt 0 ]; then
  echo "FAILURES:"
  grep 'TOOL_ERROR' "$RESULTS"
fi
