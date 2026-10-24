#!/usr/bin/env bash
# Local gateway runner (Pelaris 1.4 B2a lane C, C6 g; PLAN_B2a R3; panel
# P2-7, P4-9). Runs the built gateway against the LOCAL emulators only, in the
# foreground, for a bounded time. It refuses to start unless every value that
# could reach production points at loopback or is a known test value:
#
#   FIRESTORE_EMULATOR_HOST   set, loopback host:port
#   OAUTH_CF_BASE             loopback http URL (else /authorize, /token and
#                             /revoke proxy to the production function)
#   CF_BASE_URL               loopback http URL (else bridge_client.ts calls
#                             the production coreToolsBridge, return_check included)
#   PORT                      set, a number, and not an emulator port (8080 is
#                             the Firestore emulator's, the gateway's default)
#   MCP_JWT_SECRET            equal to the runner's dummy (the same dummy the
#   MCP_OAUTH_IP_HEADER_SECRET  wayfinder emulator runner gives the function's
#                             secrets, so locally minted tokens verify here and
#                             the value itself proves this is a test)
#   MCP_BEARER_TOKEN          empty (no admin bearer on a local run)
#   NODE_OPTIONS              preloads wayfinder's egress guard AND its strict
#                             preload (run this under tools/emulator/with_egress_guard.sh)
#   the emulator lock         held by the caller (RUNNER_LOCK_OWNER file exists)
#
# Usage (from this repo, after `npm run build`, holding the emulator lock):
#   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
#   OAUTH_CF_BASE=http://127.0.0.1:5001/wayfinder-ai-fitness/australia-southeast1/mcpOAuthServer \
#   CF_BASE_URL=http://127.0.0.1:5001/wayfinder-ai-fitness/australia-southeast1 \
#   PORT=8790 MCP_JWT_SECRET=<dummy> MCP_OAUTH_IP_HEADER_SECRET=<dummy> MCP_BEARER_TOKEN= \
#   bash <wayfinder>/tools/emulator/with_egress_guard.sh bash scripts/run_local_gateway.sh
#
# GATEWAY_LIFETIME_SECONDS (default 1800, 60 to 7200) bounds the run.
set -u

DUMMY="b0-acceptance-dummy-not-a-secret-0000000000000000000000000000"
EMULATOR_PORTS="4000 4400 4500 5001 8080 8085 8086 9099 9150 9199"
LOCK_OWNER="${RUNNER_LOCK_OWNER:-/c/tmp/emulator.lock/owner}"

refuse() {
  printf '[run_local_gateway] REFUSED: %s\n' "$*" >&2
  exit 64
}

is_loopback_hostport() {
  [[ "$1" =~ ^(127\.0\.0\.1|localhost|\[::1\]):[0-9]+$ ]]
}

is_loopback_url() {
  [[ "$1" =~ ^http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?(/.*)?$ ]]
}

[ -n "${FIRESTORE_EMULATOR_HOST:-}" ] || refuse "FIRESTORE_EMULATOR_HOST is not set"
is_loopback_hostport "$FIRESTORE_EMULATOR_HOST" || refuse "FIRESTORE_EMULATOR_HOST must be a loopback host:port"
is_loopback_url "${OAUTH_CF_BASE:-}" || refuse "OAUTH_CF_BASE must be a loopback http URL"
is_loopback_url "${CF_BASE_URL:-}" || refuse "CF_BASE_URL must be a loopback http URL"
[ -n "${PORT:-}" ] || refuse "PORT must be set (the default, 8080, is the Firestore emulator's port)"
[[ "$PORT" =~ ^[0-9]+$ ]] || refuse "PORT must be a number"
for emulator_port in $EMULATOR_PORTS; do
  [ "$PORT" = "$emulator_port" ] && refuse "PORT $PORT is an emulator port"
done
[ "${MCP_JWT_SECRET:-}" = "$DUMMY" ] || refuse "MCP_JWT_SECRET must equal the runner's dummy value"
[ "${MCP_OAUTH_IP_HEADER_SECRET:-}" = "$DUMMY" ] || refuse "MCP_OAUTH_IP_HEADER_SECRET must equal the runner's dummy value"
[ -z "${MCP_BEARER_TOKEN:-}" ] || refuse "MCP_BEARER_TOKEN must be empty"
case "${NODE_OPTIONS:-}" in
  *block_egress*) ;;
  *) refuse "NODE_OPTIONS has no egress guard: run under wayfinder's tools/emulator/with_egress_guard.sh" ;;
esac
case "${NODE_OPTIONS:-}" in
  *egress_strict*) ;;
  *) refuse "NODE_OPTIONS has no strict egress preload: run under wayfinder's tools/emulator/with_egress_guard.sh" ;;
esac
[ -f "$LOCK_OWNER" ] || refuse "the emulator lock is not held ($LOCK_OWNER missing)"
[ -f dist/index.js ] || refuse "dist/index.js is missing: run npm run build first"

LIFETIME="${GATEWAY_LIFETIME_SECONDS:-1800}"
[[ "$LIFETIME" =~ ^[0-9]+$ ]] || refuse "GATEWAY_LIFETIME_SECONDS must be a number"
[ "$LIFETIME" -ge 60 ] && [ "$LIFETIME" -le 7200 ] || refuse "GATEWAY_LIFETIME_SECONDS must be 60 to 7200"

export B2A_GATEWAY_TEST=1
printf '[run_local_gateway] local gateway on port %s for at most %ss (Firestore %s, function %s)\n' \
  "$PORT" "$LIFETIME" "$FIRESTORE_EMULATOR_HOST" "$OAUTH_CF_BASE" >&2
exec timeout "$LIFETIME" node dist/index.js
