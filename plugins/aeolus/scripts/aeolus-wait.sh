#!/usr/bin/env bash
# The watcher: started by the session as a background task before it ends its
# turn. It asks the fleet's inbox check, which claims nothing and waits up to
# 25 seconds per call, and exits only when there is something to say, which
# wakes the session. No tokens are spent while it waits.
#
# The wake hands one message over (#756), given only when the turn marker says
# the session is idle, whenever deliveries wait: the watcher takes one delivery
# with a push receive, which makes the lease pushed, reports it handed with its
# hand-over number, keeps it in the folder's store as handed, reports the turn
# busy and exits saying so, without its content. The hooks acknowledge it, then
# put it into the turn. A message the store still holds unconfirmed while the
# session is idle is handed over again at once, without a receive. The Codex
# wake bridge runs it too, and queues a prompt to the task when it exits.
#
# Exit codes:
#   0  a message is handed over
#   2  this folder crews no ship
#   3  LEASE_ENDED: the operator released the ship, and the plugin forgot it
#   4  a watcher already runs for this ship
#   5  the fleet refused the crew token
#   6  it ran for almost 2 hours, the most a background task runs: start it again
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

# How long one inbox check waits while nothing waits; the fleet's maximum.
WAIT_SECONDS="${AEOLUS_WAIT_SECONDS:-25}"
# The pause between inbox checks while deliveries wait, since the check then
# answers at once: the trierarch's pass interval.
POLL_SECONDS="${AEOLUS_POLL_SECONDS:-5}"
# The first pause after a failed call; it doubles up to the most.
RETRY_SECONDS="${AEOLUS_RETRY_SECONDS:-2}"
RETRY_MAX_SECONDS="${AEOLUS_RETRY_MAX_SECONDS:-60}"
# A background task runs at most 2 hours (in a cloud session it is then
# stopped): the watcher ends itself at 1 hour 55 minutes, saying so, and the
# session starts it again.
MAX_SECONDS="${AEOLUS_MAX_SECONDS:-6900}"

identity="$(aeolus_identity_file)" || exit 2
if ! identity_text="$(aeolus_identity_read "$identity")"; then
  echo "aeolus: this folder crews no ship; run /aeolus:crew with the crew line first"
  exit 2
fi
if aeolus_is_watching; then
  aeolus_log "$identity" watch 'not started: a watcher runs for this ship'
  echo "aeolus: already watching: a watcher runs for this ship; do not start another"
  exit 4
fi

pid_file="$(aeolus_pid_file)"
refused_file="$(aeolus_refused_file)"
waiting_file="$(aeolus_waiting_file)"
echo "$$" > "$pid_file"
trap 'rm -f "$pid_file"' EXIT
aeolus_log "$identity" watch started

fleet_url="$(aeolus_identity_field "$identity_text" fleetUrl)"
ship_name="$(aeolus_identity_field "$identity_text" shipName)"
crew_token="$(aeolus_identity_field "$identity_text" crewToken)"
# Hands a store entry over: reports it handed with its number, and once the
# fleet took that, it is the session's to confirm, its turn starts. An entry
# the fleet answers undeliverable or no longer in flight is dropped, and the
# watcher watches on; a hand-over the fleet did not take is made again with
# the same number. <deliveryId> <what the log says>.
hand_over() {
  local outcome
  call /api/v1/ship/handed "$(aeolus_store_handing "$1")" $((WAIT_SECONDS + 15))
  if [ "$status" = 200 ]; then
    answered
    outcome="$(aeolus_json_string "$body" state)"
  else
    outcome="$(aeolus_json_string "$body" code)"
  fi
  aeolus_store_handed "$identity" "$1" "$outcome"
  case $? in
    0) ;;
    1) return 0 ;;
    *)
      on_refusal
      return 0
      ;;
  esac
  aeolus_mark_turn busy
  aeolus_report_turn "$(aeolus_identity_read "$identity")"
  aeolus_log "$identity" wake "$2"
  echo "aeolus: a message for ${ship_name} is handed to this session: it reaches you at your next tool call, or when you end your turn. Do not receive or ack it."
  exit 0
}

# One call to the fleet with the crew token: <path> <body> <seconds>. Sets
# status and body.
call() {
  local answer
  answer="$(aeolus_bearer_config "$crew_token" | curl -K - -sS --max-time "$3" -w '\n%{http_code}' -X POST "${fleet_url}$1" \
    -H 'content-type: application/json' \
    -d "$2" 2>/dev/null)"
  status="$(printf '%s' "$answer" | tail -n 1)"
  body="$(printf '%s' "$answer" | sed '$d')"
}

delay="$RETRY_SECONDS"
# Whether the last call failed: a failing fleet is logged once, not every retry.
is_failing=0
RETRY_NEXT='retries, a little later each time'

# A call the fleet did not answer with OK. A refused crew token exits 5, and
# LEASE_ENDED for the file's own crew token forgets the ship and exits 3; for
# another, the folder was crewed again while it watched, and it watches on with
# the new crew token. Anything else is a failure: it waits, a little longer each
# time, and the watcher tries again.
on_refusal() {
  local current
  case "$status" in
    401)
      if printf '%s' "$body" | grep -q 'LEASE_ENDED'; then
        current="$(aeolus_identity_token "$identity")"
        if [ -n "$current" ] && [ "$current" != "$crew_token" ]; then
          fleet_url="$(aeolus_identity_get "$identity" fleetUrl)"
          ship_name="$(aeolus_identity_get "$identity" shipName)"
          crew_token="$current"
          return 0
        fi
        # The pid file goes first, so forgetting does not stop this watcher mid-sentence.
        rm -f "$pid_file"
        aeolus_log "$identity" release 'released by the operator; the plugin forgot it'
        [ -n "$current" ] && "$(dirname "$0")/aeolus-identity.sh" delete >/dev/null
        echo "aeolus: LEASE_ENDED: the operator released ${ship_name}; this session no longer crews it, and the plugin forgot it"
        exit 3
      fi
      refused_token
      ;;
    403)
      refused_token
      ;;
  esac
  if [ "$is_failing" = 0 ]; then
    case "$status" in
      ''|000) aeolus_log "$identity" watch 'failed: no answer from the fleet' "$RETRY_NEXT" ;;
      *) aeolus_log "$identity" watch "failed: the fleet answered HTTP ${status}" "$RETRY_NEXT" ;;
    esac
    is_failing=1
  fi
  sleep "$delay"
  delay=$((delay * 2))
  [ "$delay" -le "$RETRY_MAX_SECONDS" ] || delay="$RETRY_MAX_SECONDS"
}

refused_token() {
  : > "$refused_file"
  aeolus_log "$identity" watch 'failed: the fleet refused the crew token' 'no watcher is asked for until one reaches the fleet with the crew token'
  echo "aeolus: the fleet refused the crew token of ${ship_name}"
  exit 5
}

# The fleet answered: the crew token holds again.
answered() {
  rm -f "$refused_file"
  delay="$RETRY_SECONDS"
  if [ "$is_failing" = 1 ]; then
    aeolus_log "$identity" watch 'the fleet answers again'
    is_failing=0
  fi
}

while :; do
  # What the fleet did not take yet goes first, also on a watcher's last pass.
  aeolus_send_owed "$identity"
  left=$((MAX_SECONDS - SECONDS))
  if [ "$left" -le 0 ]; then
    aeolus_log "$identity" watch 'stopped after almost 2 hours; the session starts it again'
    echo "aeolus: watched ${ship_name} for almost 2 hours, the most a background task runs: start the watcher again"
    exit 6
  fi
  if aeolus_is_idle && id="$(aeolus_store_first received handed)"; then
    hand_over "$id" "handed ${id} over again: it was not confirmed"
    continue
  fi
  wait_now="$WAIT_SECONDS"
  [ "$wait_now" -le "$left" ] || wait_now="$left"
  call /api/v1/ship/inbox "{\"waitSeconds\":${wait_now}}" $((wait_now + 15))
  if [ "$status" != 200 ]; then
    on_refusal
    continue
  fi
  answered
  waiting="$(printf '%s' "$body" | sed -n 's/.*"waiting"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
  [ -n "$waiting" ] || waiting=0
  seen=0
  is_owed=0
  { read -r seen is_owed < "$waiting_file"; } 2>/dev/null
  was_owed="$is_owed"
  # A hand-over is owed whenever deliveries wait: each is handed over on its
  # own, and a drop to none and a rise again may fall within one inbox wait.
  is_owed=0
  [ "$waiting" -eq 0 ] || is_owed=1
  if [ "$is_owed" = 1 ] && aeolus_is_idle; then
    printf '%s 0\n' "$waiting" > "$waiting_file"
    # Deliveries wait, so the push receive answers at once.
    call /api/v1/ship/pushReceive '{"max":1}' $((WAIT_SECONDS + 15))
    if [ "$status" != 200 ]; then
      on_refusal
      continue
    fi
    answered
    aeolus_lease_key "$crew_token" > "$(aeolus_pushed_file)"
    if id="$(aeolus_store_put "$(printf '%s' "$body" | tr -d '\n')")"; then
      hand_over "$id" "woken, ${waiting} deliveries wait: handed ${id} over"
      continue
    fi
    # Nothing handed, as when another ship of its type took the delivery first.
    aeolus_log "$identity" wake "woken, ${waiting} deliveries wait: the receive handed nothing over"
    continue
  fi
  if [ "$is_owed" = 1 ] && { [ "$was_owed" != 1 ] || [ "$waiting" != "${seen:-0}" ]; }; then
    aeolus_log "$identity" wake "held, ${waiting} deliveries wait while the session is busy"
  fi
  printf '%s %s\n' "$waiting" "$is_owed" > "$waiting_file"
  [ "$waiting" -eq 0 ] || sleep "$POLL_SECONDS"
done
