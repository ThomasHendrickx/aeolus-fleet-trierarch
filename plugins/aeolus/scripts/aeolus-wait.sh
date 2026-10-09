#!/usr/bin/env bash
# The watcher: started by the session as a background task before it ends its
# turn. It asks the fleet's inbox check, which claims nothing and waits up to
# 25 seconds per call, and exits only when there is something to say, which
# wakes the session. No tokens are spent while it waits.
#
# Exit codes:
#   0  deliveries wait: receive them
#   2  this folder crews no ship
#   3  LEASE_ENDED: the operator released the ship, and the plugin forgot it
#   4  a watcher already runs for this ship
#   5  the fleet refused the crew token
#   6  it ran for almost 2 hours, the most a background task runs: start it again
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

# How long one inbox check waits while nothing waits; the fleet's maximum.
WAIT_SECONDS="${AEOLUS_WAIT_SECONDS:-25}"
# The first pause after a failed call; it doubles up to the most.
RETRY_SECONDS="${AEOLUS_RETRY_SECONDS:-2}"
RETRY_MAX_SECONDS="${AEOLUS_RETRY_MAX_SECONDS:-60}"
# A background task runs at most 2 hours (in a cloud session it is then
# stopped): the watcher ends itself at 1 hour 55 minutes, saying so, and the
# session starts it again.
MAX_SECONDS="${AEOLUS_MAX_SECONDS:-6900}"

identity="$(aeolus_identity_file)" || exit 2
if [ ! -f "$identity" ]; then
  echo "aeolus: this folder crews no ship; run /aeolus:crew with the crew line first"
  exit 2
fi
if aeolus_is_watching; then
  echo "aeolus: already watching: a watcher runs for this ship; do not start another"
  exit 4
fi

pid_file="$(aeolus_pid_file)"
refused_file="$(aeolus_refused_file)"
echo "$$" > "$pid_file"
trap 'rm -f "$pid_file"' EXIT

fleet_url="$(aeolus_identity_get "$identity" fleetUrl)"
ship_name="$(aeolus_identity_get "$identity" shipName)"
crew_token="$(aeolus_identity_get "$identity" crewToken)"
delay="$RETRY_SECONDS"

while :; do
  left=$((MAX_SECONDS - SECONDS))
  if [ "$left" -le 0 ]; then
    echo "aeolus: watched ${ship_name} for almost 2 hours, the most a background task runs: start the watcher again"
    exit 6
  fi
  wait_now="$WAIT_SECONDS"
  [ "$wait_now" -le "$left" ] || wait_now="$left"
  answer="$(curl -sS --max-time $((wait_now + 15)) -w '\n%{http_code}' -X POST "${fleet_url}/api/v1/ship/inbox" \
    -H "authorization: Bearer ${crew_token}" -H 'content-type: application/json' \
    -d "{\"waitSeconds\":${wait_now}}" 2>/dev/null)"
  status="$(printf '%s' "$answer" | tail -n 1)"
  body="$(printf '%s' "$answer" | sed '$d')"
  case "$status" in
    200)
      rm -f "$refused_file"
      delay="$RETRY_SECONDS"
      waiting="$(printf '%s' "$body" | sed -n 's/.*"waiting"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
      if [ -n "$waiting" ] && [ "$waiting" -gt 0 ]; then
        echo "aeolus: ${waiting} deliveries wait for ${ship_name}: receive them"
        exit 0
      fi
      continue
      ;;
    401)
      if printf '%s' "$body" | grep -q 'LEASE_ENDED'; then
        # Crewed again while it watched: watch on with the new crew token.
        current="$(aeolus_identity_token "$identity")"
        if [ -n "$current" ] && [ "$current" != "$crew_token" ]; then
          fleet_url="$(aeolus_identity_get "$identity" fleetUrl)"
          ship_name="$(aeolus_identity_get "$identity" shipName)"
          crew_token="$current"
          continue
        fi
        # The lease of the file's own crew token ended: forget the ship. The pid
        # file goes first, so forgetting does not stop this watcher mid-sentence.
        rm -f "$pid_file"
        [ -n "$current" ] && "$(dirname "$0")/aeolus-identity.sh" delete >/dev/null
        echo "aeolus: LEASE_ENDED: the operator released ${ship_name}; this session no longer crews it, and the plugin forgot it"
        exit 3
      fi
      : > "$refused_file"
      echo "aeolus: the fleet refused the crew token of ${ship_name}"
      exit 5
      ;;
    403)
      : > "$refused_file"
      echo "aeolus: the fleet refused the crew token of ${ship_name}"
      exit 5
      ;;
  esac
  # No answer, or a server failure: try again quietly, a little later each time.
  sleep "$delay"
  delay=$((delay * 2))
  [ "$delay" -le "$RETRY_MAX_SECONDS" ] || delay="$RETRY_MAX_SECONDS"
done
