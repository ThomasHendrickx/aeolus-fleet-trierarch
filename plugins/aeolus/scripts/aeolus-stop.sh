#!/usr/bin/env bash
# Stop hook: at the end of every turn, makes sure something wakes the session
# when work arrives for the folder's ship, so no session has to remember.
#   Codex: re-arms the wake bridge for the task; a bridge already armed for it
#   stays as it is.
#   Claude Code: a session wakes only through its own background task, which a
#   hook cannot start, so when no watcher runs the hook keeps the turn open once
#   and asks the session to start it.
# In a folder a trierarch crews (wakeBy=trierarch), it only marks the turn idle:
# the trierarch wakes the session. Silent when the folder crews no ship, a
# watcher runs, or the fleet refused the crew token. Never fails the session.
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

payload="$(cat)"
aeolus_hook_folder "$payload"
identity="$(aeolus_identity_file 2>/dev/null)" || exit 0
[ -f "$identity" ] || exit 0

if aeolus_woken_by_trierarch "$identity"; then
  aeolus_mark_turn "$identity" idle
  exit 0
fi

if [ -n "${PLUGIN_ROOT:-}" ]; then
  session_id="$(aeolus_json_string "$payload" session_id)"
  [ -n "$session_id" ] && [ "${AEOLUS_CODEX_WAKE_DISABLED:-}" != 1 ] || exit 0
  "$(dirname "$0")/aeolus-codex-wake.sh" start "$session_id" >/dev/null 2>&1 || true
  exit 0
fi

printf '%s' "$payload" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true' && exit 0
aeolus_is_watching && exit 0
[ -f "$(aeolus_refused_file)" ] && exit 0

root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
ship_name="$(aeolus_identity_get "$identity" shipName)"
reason="aeolus: no watcher runs for ${ship_name}, so nothing wakes this session when work arrives: start \"${root}/scripts/aeolus-wait.sh\" as a background task (run_in_background), then end your turn"
printf '{"decision":"block","reason":"%s"}\n' "$(aeolus_json_escape "$reason")"
