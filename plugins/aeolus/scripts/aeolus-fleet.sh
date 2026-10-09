#!/usr/bin/env bash
# The one door of a session's fleet calls, over the fleet's REST API. Register
# takes the crew line's secret and keeps the crew token in the folder's
# identity file; every later call reads it there and sends it as the bearer, so
# the token never reaches the model or its transcript. Prints what the fleet
# answers, as JSON, never the crew token.
#
#   aeolus-fleet.sh register <fleetUrl> <shipId> <secret> <location> [<squadronId>]
#       location: DEVICE, CLOUD, SERVER or OTHER:<a few words>; the harness is
#       AEOLUS_HARNESS, else claude-code
#   aeolus-fleet.sh receive|send|report|inbox [<json input>|-]   - reads the input from stdin
#   aeolus-fleet.sh ack|pong <deliveryId>
#   aeolus-fleet.sh whoami|reportLog|deregister
#   aeolus-fleet.sh protocol    the ship protocol, as the fleet states it
#
# Exit codes:
#   0  done: the fleet's answer is printed
#   1  the fleet refused: its code and message are printed
#   2  this folder crews no ship, or the call is not one of these
#   3  LEASE_ENDED: the operator released the ship
#   4  register: this folder already crews a ship
#   6  no answer from the fleet
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

# The longest a call may take: receive and inbox wait up to 25 seconds.
MAX_SECONDS=60

usage() {
  echo "usage: aeolus-fleet.sh register|receive|ack|pong|send|report|inbox|whoami|reportLog|deregister|protocol ..." >&2
  exit 2
}

# One call to the fleet: <method> <path> <crew token or empty> <body or empty>.
# Sets status and body; exits 6 when the fleet does not answer.
call_fleet() {
  local method="$1" path="$2" token="$3" input="$4" answer
  local args=(-sS --max-time "$MAX_SECONDS" -w '\n%{http_code}' -X "$method" "${fleet_url}${path}")
  [ -n "$token" ] && args+=(-H "authorization: Bearer ${token}")
  [ -n "$input" ] && args+=(-H 'content-type: application/json' --data-binary "$input")
  answer="$(curl "${args[@]}" 2>/dev/null)"
  status="$(printf '%s' "$answer" | tail -n 1)"
  body="$(printf '%s' "$answer" | sed '$d')"
  if [ -z "$status" ] || [ "$status" = 000 ]; then
    echo "aeolus: no answer from ${fleet_url}"
    exit 6
  fi
}

# A refusal, as the fleet states it: LEASE_ENDED exits 3, any other 1.
refused() {
  local call="$1" code
  code="$(aeolus_json_string "$body" code)"
  if [ "$code" = LEASE_ENDED ]; then
    echo "aeolus: LEASE_ENDED: the operator released the ship; this session no longer crews it"
    exit 3
  fi
  echo "aeolus: the fleet refused ${call}: ${code:-HTTP ${status}}: $(aeolus_json_string "$body" message)"
  exit 1
}

# JSON string contents undone: \n, \t, \", \/ and \\ (the protocol holds no other escapes).
json_unescape() {
  awk '{
    out = ""
    for (i = 1; i <= length($0); i++) {
      c = substr($0, i, 1)
      if (c == "\\" && i < length($0)) {
        i++
        c = substr($0, i, 1)
        if (c == "n") c = "\n"
        else if (c == "t") c = "\t"
      }
      out = out c
    }
    printf "%s", out
  }'
}

register() {
  [ "$#" -eq 4 ] || [ "$#" -eq 5 ] || usage
  local ship_id="$2" secret="$3" location squadron="${5:-}" token name
  fleet_url="${1%/}"
  case "$4" in
    DEVICE|CLOUD|SERVER) location="{\"kind\":\"$4\"}" ;;
    OTHER:?*) location="{\"kind\":\"OTHER\",\"description\":\"$(aeolus_json_escape "${4#OTHER:}")\"}" ;;
    *) echo "aeolus: the location is DEVICE, CLOUD, SERVER or OTHER:<a few words>" >&2; exit 2 ;;
  esac
  if [ -f "$identity" ]; then
    echo "aeolus: this folder already crews $(aeolus_identity_get "$identity" shipName) ($(aeolus_identity_get "$identity" shipId)); one folder crews one ship, and deregistering frees it"
    exit 4
  fi
  call_fleet POST /api/v1/ship/register "" "{\"shipId\":\"$(aeolus_json_escape "$ship_id")\",\"secret\":\"$(aeolus_json_escape "$secret")\",\"location\":${location},\"harness\":\"$(aeolus_json_escape "${AEOLUS_HARNESS:-claude-code}")\"}"
  [ "$status" = 200 ] || refused register
  token="$(aeolus_json_string "$body" crewToken)"
  [ -n "$token" ] || { echo "aeolus: the fleet answered register without a crew token"; exit 1; }
  # The lease is claimed now: keep the token whatever whoami answers, named by the ship id if need be.
  name="$ship_id"
  call_fleet GET /api/v1/ship/whoami "$token" ""
  [ "$status" = 200 ] && name="$(aeolus_json_string "$body" name)"
  [ -n "$name" ] || name="$ship_id"
  "$(dirname "$0")/aeolus-identity.sh" write "$fleet_url" "$ship_id" "$name" "$token" ${squadron:+"$squadron"} >/dev/null || exit 1
  echo "aeolus: this folder now crews ${name} (${ship_id})"
}

identity="$(aeolus_identity_file)" || exit 2
command="${1:-}"
[ -n "$command" ] || usage

if [ "$command" = register ]; then
  shift
  register "$@"
  exit 0
fi

if [ ! -f "$identity" ]; then
  echo "aeolus: this folder crews no ship; crew one with its crew line first"
  exit 2
fi
fleet_url="$(aeolus_identity_get "$identity" fleetUrl)"

if [ "$command" = protocol ]; then
  call_fleet GET /api/v1/openapi.json "" ""
  [ "$status" = 200 ] || refused protocol
  printf '%s' "$body" | tr -d '\n' \
    | sed -E -n 's/^.*"info"[[:space:]]*:[[:space:]]*\{"title":"([^"\\]|\\.)*","version":"([^"\\]|\\.)*","description":"(([^"\\]|\\.)*)".*$/\3/p' \
    | json_unescape
  echo
  exit 0
fi

case "$command" in
  receive|send|report|inbox)
    input="${2:-}"
    [ -n "$input" ] || input='{}'
    [ "$input" = - ] && input="$(cat)"
    method=POST
    ;;
  ack|pong)
    [ "$#" -eq 2 ] || usage
    input="{\"deliveryId\":\"$(aeolus_json_escape "$2")\"}"
    method=POST
    ;;
  whoami|reportLog)
    input=""
    method=GET
    ;;
  deregister)
    input=""
    method=POST
    ;;
  *)
    usage
    ;;
esac

call_fleet "$method" "/api/v1/ship/${command}" "$(aeolus_identity_get "$identity" crewToken)" "$input"
[ "$status" = 200 ] || refused "$command"
printf '%s\n' "$body"
