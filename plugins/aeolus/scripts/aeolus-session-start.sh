#!/usr/bin/env bash
# SessionStart hook (startup, resume, clear, compact). Exports the session's
# folder and the plugin's paths for the session's commands, then, when the
# folder crews a ship, tells the fresh context which one and how to go on.
# Silent otherwise. Never fails the session.
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

payload="$(cat)"
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

if [ -n "${PLUGIN_ROOT:-}" ]; then
  model="$(aeolus_json_string "$payload" model)"
  session_id="$(aeolus_json_string "$payload" session_id)"
  identity="$(aeolus_identity_file 2>/dev/null)" || exit 0
  context="Aeolus Codex hooks are active. The plugin root is ${root}; plugin data is ${AEOLUS_DATA}; the working folder is ${AEOLUS_FOLDER}."
  [ -n "$model" ] && context="${context} The active model is ${model}."
  [ -n "$session_id" ] && context="${context} The Codex task id is ${session_id}."
  if [ ! -f "$identity" ]; then
    context="${context} This folder crews no Aeolus ship. When an Aeolus skill runs, pass AEOLUS_DATA and AEOLUS_FOLDER with the values above to its scripts."
    printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$(aeolus_json_escape "$context")"
    exit 0
  fi

  ship_name="$(aeolus_identity_get "$identity" shipName)"
  ship_id="$(aeolus_identity_get "$identity" shipId)"
  fleet_url="$(aeolus_identity_get "$identity" fleetUrl)"
  squadron="$(aeolus_identity_get "$identity" squadron)"
  wake_failed=0
  if aeolus_woken_by_trierarch "$identity"; then
    session_id=""
  fi
  if [ -n "$session_id" ] && [ "${AEOLUS_CODEX_WAKE_DISABLED:-}" != 1 ]; then
    if ! wake_answer="$("$root/scripts/aeolus-codex-wake.sh" start "$session_id" 2>&1)"; then
      context="${context} Automatic local wake-up failed: ${wake_answer}"
      wake_failed=1
    fi
  fi
  context="${context} This folder crews the Aeolus ship ${ship_name} (${ship_id}) in the fleet at ${fleet_url}. Its crew token is the crewToken line of ${identity}: read it there and pass it to every fleet call. Do not register again. Go on as the aeolus-crew skill says: receive and handle what waits, then end the turn."
  if aeolus_woken_by_trierarch "$identity"; then
    context="${context} The trierarch wakes this session when work arrives: start no watcher."
  elif [ -n "$session_id" ] && [ "$wake_failed" -eq 0 ]; then
    context="${context} Automatic local wake-up targets this Codex task (${session_id}); re-arm it before ending each completed turn."
  fi
  if [ -n "$squadron" ]; then
    context="${context} This ship is a member of the squadron ${squadron}. Before anything else, check in at its flagship ${squadron} as the aeolus-crew skill says."
    check_in="$(aeolus_identity_get "$identity" checkIn)"
    [ -n "$check_in" ] && context="${context} Its check-in interval is ${check_in}: report at least once per interval; the plugin reminds you when one passes without a report."
  fi
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$(aeolus_json_escape "$context")"
  exit 0
fi

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  printf 'export AEOLUS_FOLDER=%q\nexport AEOLUS_DATA=%q\nexport AEOLUS_ROOT=%q\n' "$AEOLUS_FOLDER" "$AEOLUS_DATA" "$root" >> "$CLAUDE_ENV_FILE"
fi

identity="$(aeolus_identity_file 2>/dev/null)" || exit 0
[ -f "$identity" ] || exit 0

ship_name="$(aeolus_identity_get "$identity" shipName)"
ship_id="$(aeolus_identity_get "$identity" shipId)"
fleet_url="$(aeolus_identity_get "$identity" fleetUrl)"
squadron="$(aeolus_identity_get "$identity" squadron)"
context="This folder crews the Aeolus ship ${ship_name} (${ship_id}) in the fleet at ${fleet_url}. Every fleet call goes through \"${root}/scripts/aeolus-fleet.sh\", which adds the crew token: never read the identity file or pass a crew token. Do not register again."
if [ -n "$squadron" ]; then
  context="${context} This ship is a member of the squadron ${squadron}. Before anything else, check in at its flagship ${squadron}, as the aeolus crew-a-ship skill says for a squadron member."
  check_in="$(aeolus_identity_get "$identity" checkIn)"
  [ -n "$check_in" ] && context="${context} Its check-in interval is ${check_in}: report at least once per interval; the plugin reminds you when one passes without a report."
fi
if aeolus_woken_by_trierarch "$identity"; then
  context="${context} Go on as the aeolus crew-a-ship skill says: fetch the protocol, receive and handle what waits; then end your turn. The trierarch wakes this session when work arrives: start no watcher."
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$(aeolus_json_escape "$context")"
  exit 0
fi
context="${context} Go on as the aeolus crew-a-ship skill says: fetch the protocol, receive and handle what waits; then, unless \"${root}/scripts/aeolus-watch-status.sh\" says watching, start \"${root}/scripts/aeolus-wait.sh\" as a background task; then end your turn. When the watcher exits 6 (its 2-hour limit), just start it again."
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$(aeolus_json_escape "$context")"
