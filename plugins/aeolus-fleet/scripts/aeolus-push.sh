#!/usr/bin/env bash
# The trierarch's hand-over (#756), for a folder it crews: what the watcher
# does for a session crewed by hand, one call at a time, through the same
# store, so the trierarch never writes the store itself. The plugin's hooks
# then acknowledge each message before they put it into the turn.
#
#   aeolus-push.sh hand   given while the turn marker says idle: hands one
#                         message over and prints the line to type into the
#                         session. A message to hand once more goes first, its
#                         hand-over reported by the prompt the line starts;
#                         then one received or handed and not confirmed, again
#                         with the next number; else one push receive, which
#                         makes the lease pushed, reported handed with its
#                         number. Marks the turn busy, so the next pass waits.
#   aeolus-push.sh force  given while a forced message waits (decision 0040),
#                         idle or busy: hands it over first, before what the
#                         store holds, with one push receive, which answers a
#                         forced delivery first, and prints the line to type.
#                         A plain one it answers instead, as when another ship
#                         of the type took the forced one first, is kept for
#                         the next idle while the turn is busy: nothing is
#                         handed over, so no turn is stopped for it.
#                         While the turn is busy the trierarch then stops it
#                         and types the line as a new prompt: the stop is
#                         marked first, so a stopped turn is not taken as one
#                         that died, and what it confirmed is handled when the
#                         forced turn ends.
#   aeolus-push.sh died   the session died, before the trierarch starts it
#                         again: a confirmed message is kept to hand once more,
#                         one handed once more already is reported not handled,
#                         and one received or handed is reported handed again
#                         with the next number, for the next prompt to confirm.
#                         Marks the turn busy: the trierarch starts the session
#                         again with a prompt, and a marker left idle by the
#                         session that died would let a pass hand a message
#                         into that turn (#890). Its Stop hook marks it idle.
#
# Exit codes:
#   0  hand, force: a message is handed over: type the line; died: done
#   1  hand, force: nothing is handed over
#   2  this folder crews no ship, or the command is not one of these
#   3  LEASE_ENDED: the store is forgotten
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"
# The store stays the session's plugins' (aeolus_store_version_guard).
aeolus_is_store_claimed=0

# How long the push receive may wait: it waits about 25 seconds when nothing
# is there, and the trierarch's pass waits for it. A delivery taken after the
# call gave up comes first again at the next push receive.
PUSH_RECEIVE_SECONDS="${AEOLUS_PUSH_RECEIVE_SECONDS:-5}"

identity="$(aeolus_identity_file)" || exit 2
identity_text="$(aeolus_identity_read "$identity")" || { echo "aeolus: this folder crews no ship" >&2; exit 2; }
ship_name="$(aeolus_identity_field "$identity_text" shipName)"

# Whether a forced stop's mark stays: only once a message is handed over.
is_stop_kept=0

# The message is the session's to confirm: the turn is busy from now, and the
# line goes into the session. <what the log says>
handed_over() {
  is_stop_kept=1
  aeolus_mark_turn busy
  aeolus_report_turn "$(aeolus_identity_read "$identity")"
  aeolus_log "$identity" wake "$1"
  echo "Aeolus handed a message for ${ship_name} to this session: it comes into this turn through the plugin's hooks, acknowledged. Do not receive or ack it."
  exit 0
}

# Reports an entry handed: handed over, dropped (nothing to hand), not taken
# (handed again at the next pass) or LEASE_ENDED. <deliveryId> <what the log says>
hand_entry() {
  aeolus_report_handed "$identity" "$1"
  case $? in
    0) handed_over "$2" ;;
    1)
      [ -d "$(aeolus_store_dir)" ] || exit 3
      exit 1
      ;;
  esac
  exit 1
}

hand() {
  local id
  aeolus_send_owed "$identity"
  if id="$(aeolus_store_first onceMore)"; then
    handed_over "woken: ${id} to hand once more"
  fi
  if id="$(aeolus_store_first received handed)"; then
    hand_entry "$id" "woken: handed ${id} over again: it was not confirmed"
  fi
  push_receive
  hand_entry "$id" "woken: handed ${id} over"
}

# One push receive: sets id to the entry of what the fleet answers first, a
# forced delivery before any other. Exits 1 when it answers nothing.
push_receive() {
  local output wait
  # The fleet's key is cut off (decision 0068): not asked again within the wait.
  if aeolus_key_wait_active; then
    exit 1
  fi
  output="$(AEOLUS_CALL_MAX_SECONDS="$PUSH_RECEIVE_SECONDS" "$(dirname "$0")/aeolus-fleet.sh" pushReceive '{"max":1}' 2>/dev/null)"
  case $? in
    0) ;;
    3)
      aeolus_store_forget
      exit 3
      ;;
    *)
      if printf '%s' "$output" | grep -q ': KEY_UNAVAILABLE:'; then
        [ -f "$(aeolus_key_wait_file)" ] || aeolus_report_key blocked
        wait="$(aeolus_key_wait_start)"
        aeolus_log "$identity" wake "waiting: the fleet's key is not reachable (KEY_UNAVAILABLE)" "asks again after ${wait} seconds, longer each time"
        exit 1
      fi
      aeolus_log "$identity" wake "failed: no push receive: ${output:-no answer}" 'the next pass tries again'
      exit 1
      ;;
  esac
  if [ -f "$(aeolus_key_wait_file)" ]; then
    aeolus_key_wait_clear
    aeolus_report_key back
  fi
  aeolus_identity_lease_key "$identity_text" > "$(aeolus_pushed_file)"
  if ! id="$(aeolus_store_put "$(printf '%s' "$output" | tr -d '\n')")"; then
    # Nothing handed, as when another ship of its type took the delivery first.
    exit 1
  fi
}

force() {
  local mark
  aeolus_send_owed "$identity"
  mark="$(aeolus_forced_stop_file)" || exit 2
  : > "$mark"
  trap '[ "$is_stop_kept" = 1 ] || rm -f "$mark"' EXIT
  push_receive
  if ! aeolus_is_idle && ! aeolus_store_is_forced "$id"; then
    aeolus_log "$identity" wake "forced: the push receive answered ${id}, not forced: kept for the next idle"
    exit 1
  fi
  hand_entry "$id" "forced: handed ${id} over"
}

case "${1:-}" in
  hand) hand ;;
  force) force ;;
  died)
    aeolus_store_session_started "$identity" 'the session it was handed once more to died too (the trierarch starts it again)'
    aeolus_mark_turn busy
    aeolus_report_turn "$(aeolus_identity_read "$identity")"
    exit 0
    ;;
  *)
    echo "usage: aeolus-push.sh hand|force|died" >&2
    exit 2
    ;;
esac
