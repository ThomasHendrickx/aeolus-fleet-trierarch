#!/usr/bin/env bash
# SessionStart hook (startup, resume, clear, compact). Exports the session's
# folder and the plugin's paths for the session's commands, then, when the
# folder crews a ship, tells the fresh context which one and how to go on.
# Silent otherwise. Never fails the session.
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

payload="$(cat)"
# The cwd field of the hook's JSON payload, its escapes undone.
cwd="$(printf '%s' "$payload" | tr -d '\n' | sed -E -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/p' | sed -e 's/\\"/"/g' -e 's/\\\\/\\/g')"
[ -n "$cwd" ] || cwd="${CLAUDE_PROJECT_DIR:-}"
[ -n "$cwd" ] || exit 0
export AEOLUS_FOLDER="$cwd"
export AEOLUS_DATA="${PLUGIN_DATA:-${CLAUDE_PLUGIN_DATA:-}}"
root="${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}}"

if [ -n "${PLUGIN_ROOT:-}" ]; then
  model="$(printf '%s' "$payload" | tr -d '\n' | sed -E -n 's/.*"model"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/p' | sed -e 's/\\"/"/g' -e 's/\\\\/\\/g')"
  session_id="$(printf '%s' "$payload" | tr -d '\n' | sed -E -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/p' | sed -e 's/\\"/"/g' -e 's/\\\\/\\/g')"
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
  if [ -n "$session_id" ] && [ "${AEOLUS_CODEX_WAKE_DISABLED:-}" != 1 ]; then
    "$root/scripts/aeolus-codex-wake.sh" start "$session_id" >/dev/null 2>&1 || true
  fi
  context="${context} This folder crews the Aeolus ship ${ship_name} (${ship_id}) in the fleet at ${fleet_url}. Its crew token is the crewToken line of ${identity}: read it there and pass it to every fleet call. Do not register again. Go on as the aeolus-crew skill says: receive and handle what waits, then end the turn."
  [ -z "$session_id" ] || context="${context} Automatic local wake-up targets this Codex task (${session_id}); re-arm it before ending each completed turn."
  if [ -n "$squadron" ]; then
    context="${context} This ship is a member of the squadron ${squadron}. Before anything else, check in at its flagship ${squadron} as the aeolus-crew skill says."
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
context="This folder crews the Aeolus ship ${ship_name} (${ship_id}) in the fleet at ${fleet_url}. Its crew token is the crewToken line of ${identity}: read it from there and pass it to every fleet call. Do not register again."
if [ -n "$squadron" ]; then
  context="${context} This ship is a member of the squadron ${squadron}. Before anything else, check in at its flagship ${squadron}, as the aeolus crew-a-ship skill says for a squadron member."
fi
context="${context} Go on as the aeolus crew-a-ship skill says: receive and handle what waits; then, unless \"${root}/scripts/aeolus-watch-status.sh\" says watching, start \"${root}/scripts/aeolus-wait.sh\" as a background task; then end your turn. When the watcher exits 6 (its 2-hour limit), just start it again."
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$(aeolus_json_escape "$context")"
