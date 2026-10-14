#!/usr/bin/env bash
# SessionStart hook (startup, resume, clear, compact). Exports the session's
# folder and the plugin's paths for the session's commands, then, when the
# folder crews a ship, tells the fresh context which one and how to go on.
# Silent otherwise. Never fails the session.
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

payload="$(cat)"
source_event="$(aeolus_json_string "$payload" source)"
# The folder the session started in: Claude Code's project folder, which stays
# the same for the whole session. The payload's cwd follows the session into a
# subfolder, so after /clear or a compact there it would key another ship (#334).
# Codex has no project folder and keeps its cwd.
cwd="${CLAUDE_PROJECT_DIR:-}"
[ -n "$cwd" ] || cwd="$(aeolus_json_string "$payload" cwd)"
[ -n "$cwd" ] || exit 0
export AEOLUS_FOLDER="$cwd"
export AEOLUS_DATA="${PLUGIN_DATA:-${CLAUDE_PLUGIN_DATA:-}}"
root="${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}}"
# The Codex wake bridge logs to the plugin's log now: a .wake.log an earlier
# plugin left beside the identities is no longer written, so it goes (#678).
# Its bridge kept its watcher's output in <key>.wake.log.wait.<pid>, today's in
# <key>.wake.wait.<pid>, and a bridge killed with SIGKILL leaves it: one whose
# pid is no live bridge goes (#688, #707).
if ships="$(aeolus_ships_dir 2>/dev/null)"; then
  rm -f "$ships"/*.wake.log
  for wait_output in "$ships"/*.wake.log.wait.* "$ships"/*.wake.wait.*; do
    aeolus_process_is "${wait_output##*.}" aeolus-codex-wake.sh || rm -f "$wait_output"
  done
fi

if [ -n "${PLUGIN_ROOT:-}" ]; then
  model="$(aeolus_json_string "$payload" model)"
  session_id="$(aeolus_json_string "$payload" session_id)"
  identity="$(aeolus_identity_file 2>/dev/null)" || exit 0
  context="Aeolus Codex hooks are active. The plugin root is ${root}; plugin data is ${AEOLUS_DATA}; the working folder is ${AEOLUS_FOLDER}."
  [ -n "$model" ] && context="${context} The active model is ${model}."
  [ -n "$session_id" ] && context="${context} The Codex task id is ${session_id}."
  if ! identity_text="$(aeolus_identity_read "$identity")"; then
    context="${context} This folder crews no Aeolus ship. When an Aeolus skill runs, pass AEOLUS_DATA and AEOLUS_FOLDER with the values above, and AEOLUS_HARNESS=codex, to its scripts."
    printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$(aeolus_json_escape "$context")"
    exit 0
  fi

  ship_name="$(aeolus_identity_field "$identity_text" shipName)"
  ship_id="$(aeolus_identity_field "$identity_text" shipId)"
  fleet_url="$(aeolus_identity_field "$identity_text" fleetUrl)"
  squadron="$(aeolus_identity_field "$identity_text" squadron)"
  wake_failed=0
  told='and that nothing wakes it'
  if aeolus_woken_by_trierarch "$identity_text"; then
    session_id=""
  fi
  if [ -n "$session_id" ] && [ "${AEOLUS_CODEX_WAKE_DISABLED:-}" != 1 ]; then
    if ! wake_answer="$("$root/scripts/aeolus-codex-wake.sh" start "$session_id" 2>&1)"; then
      context="${context} Automatic local wake-up failed: ${wake_answer}"
      wake_failed=1
      told='and that its wake bridge failed to arm'
    fi
  fi
  context="${context} This folder crews the Aeolus ship ${ship_name} (${ship_id}) in the fleet at ${fleet_url}. Every fleet call goes through ${root}/scripts/aeolus-fleet.sh, run with AEOLUS_DATA and AEOLUS_FOLDER as above and AEOLUS_HARNESS=codex; it adds the crew token: never read the identity file or pass a crew token. Do not register again."
  # A pushed lease (#756): the bridge hands each message over, so the task receives nothing itself.
  if aeolus_reports_here "$identity_text"; then
    handing='the wake bridge'
    ! aeolus_woken_by_trierarch "$identity_text" || handing='the trierarch'
    context="${context} Go on as the aeolus-crew skill says: fetch the protocol. Receive and ack nothing: this ship is pushed, so ${handing} hands each message over and it comes into the turn through the plugin's hooks. Then end the turn."
  else
    context="${context} Go on as the aeolus-crew skill says: fetch the protocol, receive and handle what waits, then end the turn."
  fi
  if aeolus_woken_by_trierarch "$identity_text"; then
    context="${context} The trierarch wakes this session when work arrives: start no watcher."
    told='and that the trierarch wakes it'
  elif [ -n "$session_id" ] && [ "$wake_failed" -eq 0 ]; then
    context="${context} Automatic local wake-up targets this Codex task (${session_id}); re-arm it before ending each completed turn."
    told='and armed the wake bridge for its task'
  fi
  if [ -n "$squadron" ]; then
    context="${context} This ship is a member of the squadron ${squadron}. Before anything else, check in at its flagship ${squadron} as the aeolus-crew skill says."
    check_in="$(aeolus_identity_field "$identity_text" checkIn)"
    [ -n "$check_in" ] && context="${context} Its check-in interval is ${check_in}: report at least once per interval; the plugin reminds you when one passes without a report."
  fi
  aeolus_log "$identity" sessionStart "told the session after ${source_event:-start} which ship it crews, ${told}"
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$(aeolus_json_escape "$context")"
  exit 0
fi

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  printf 'export AEOLUS_FOLDER=%q\nexport AEOLUS_DATA=%q\nexport AEOLUS_ROOT=%q\n' "$AEOLUS_FOLDER" "$AEOLUS_DATA" "$root" >> "$CLAUDE_ENV_FILE"
fi

identity="$(aeolus_identity_file 2>/dev/null)" || exit 0
identity_text="$(aeolus_identity_read "$identity")" || exit 0
# A person started the session again (#756, D6): what the store holds waits
# for the first prompt. Never after /clear or a compact: the session lives on.
case "$source_event" in
  startup|resume) aeolus_woken_by_trierarch "$identity_text" || ! aeolus_reports_here "$identity_text" || aeolus_store_session_started "$identity" ;;
esac

ship_name="$(aeolus_identity_field "$identity_text" shipName)"
ship_id="$(aeolus_identity_field "$identity_text" shipId)"
fleet_url="$(aeolus_identity_field "$identity_text" fleetUrl)"
squadron="$(aeolus_identity_field "$identity_text" squadron)"
context="This folder crews the Aeolus ship ${ship_name} (${ship_id}) in the fleet at ${fleet_url}. Every fleet call goes through \"${root}/scripts/aeolus-fleet.sh\", which adds the crew token: never read the identity file or pass a crew token. Do not register again."
if [ -n "$squadron" ]; then
  context="${context} This ship is a member of the squadron ${squadron}. Before anything else, check in at its flagship ${squadron}, as the aeolus crew-a-ship skill says for a squadron member."
  check_in="$(aeolus_identity_field "$identity_text" checkIn)"
  [ -n "$check_in" ] && context="${context} Its check-in interval is ${check_in}: report at least once per interval; the plugin reminds you when one passes without a report."
fi
if aeolus_woken_by_trierarch "$identity_text"; then
  # A pushed lease (#756): the trierarch hands each message over, so the session receives nothing itself.
  if aeolus_reports_here "$identity_text"; then
    handle="fetch the protocol. Receive and ack nothing: this ship is pushed, so the trierarch hands each message over and it comes into the turn through the plugin's hooks. Then"
  else
    handle='fetch the protocol, receive and handle what waits; then'
  fi
  context="${context} Go on as the aeolus crew-a-ship skill says: ${handle} end your turn. The trierarch wakes this session when work arrives: start no watcher."
  aeolus_log "$identity" sessionStart "told the session after ${source_event:-start} which ship it crews, and that the trierarch wakes it"
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$(aeolus_json_escape "$context")"
  exit 0
fi
# A pushed lease (#756): the watcher hands each message over, so the session receives nothing itself.
if aeolus_reports_here "$identity_text"; then
  handle="fetch the protocol. Receive and ack nothing: this ship is pushed, so the watcher hands each message over and it comes into the turn through the plugin's hooks. Then"
else
  handle='fetch the protocol, receive and handle what waits; then'
fi
context="${context} Go on as the aeolus crew-a-ship skill says: ${handle}, unless \"${root}/scripts/aeolus-watch-status.sh\" says watching, start \"${root}/scripts/aeolus-wait.sh\" as a background task; then end your turn. When the watcher exits 6 (its 2-hour limit), just start it again."
aeolus_log "$identity" sessionStart "told the session after ${source_event:-start} which ship it crews, and to start the watcher"
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$(aeolus_json_escape "$context")"
