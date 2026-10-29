#!/usr/bin/env bash
# Stop hook: at the end of every turn, makes sure something wakes the session
# when work arrives for the folder's ship, so no session has to remember.
#   Codex: re-arms the wake bridge for the task; a bridge already armed for it
#   stays as it is.
#   Claude Code: a session wakes only through its own background task, which a
#   hook cannot start, so when no watcher runs the hook keeps the turn open once
#   and asks the session to start it.
#   Copilot: runs no watcher, so the hook asks for none.
# A message the watcher handed over and no tool call confirmed yet is
# confirmed here (#756): acknowledged first, then the turn is kept open with it,
# asking for the watcher too when none runs. Under a trierarch too, for a line
# that landed mid-turn.
# Marks the turn idle whenever it lets the turn end, so the watcher wakes the
# session only then, and ends what the turn took as handled. In a folder a trierarch crews (wakeBy=trierarch), that is
# all it does: the trierarch wakes the session. Silent when the folder crews no
# ship, a watcher runs, or the fleet refused the crew token. Never fails the
# session.
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

payload="$(cat)"
aeolus_hook_folder "$payload" || exit 1
identity="$(aeolus_identity_file 2>/dev/null)" || exit 0
identity_text="$(aeolus_identity_read "$identity")" || exit 0

# Lets the turn end: the session is idle, and what the turn took is handled.
# On a pushed lease the fleet is told, after what it did not take before.
let_end() {
  rm -f "$(aeolus_forced_stop_file)"
  aeolus_send_owed "$identity"
  aeolus_store_end_turn "$identity"
  aeolus_mark_turn idle
  aeolus_log "$identity" turn 'idle: the turn ended'
  aeolus_report_turn "$(aeolus_identity_read "$identity")"
}

root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
ship_name="$(aeolus_identity_field "$identity_text" shipName)"

if ! aeolus_codex_hook && text="$(aeolus_put_into_turn "$identity" "$ship_name" "$root" '')"; then
  reason="${text%x}"
  if [ "${AEOLUS_HARNESS:-}" != copilot ] && ! aeolus_woken_by_trierarch "$identity_text" && ! aeolus_is_watching && [ ! -f "$(aeolus_refused_file)" ]; then
    reason="${reason}"$'\n\n'"aeolus: no watcher runs for ${ship_name}: when you are done, start \"${root}/scripts/aeolus-wait.sh\" as a background task (run_in_background), then end your turn"
  fi
  printf '{"decision":"block","reason":"%s"}\n' "$(aeolus_json_escape "$reason")"
  exit 0
fi

if aeolus_woken_by_trierarch "$identity_text"; then
  let_end
  exit 0
fi

if aeolus_codex_hook; then
  let_end
  session_id="$(aeolus_json_string "$payload" session_id)"
  [ -n "$session_id" ] && [ "${AEOLUS_CODEX_WAKE_DISABLED:-}" != 1 ] || exit 0
  "$(dirname "$0")/aeolus-codex-wake.sh" start "$session_id" >/dev/null 2>&1 || true
  exit 0
fi

# Copilot runs no watcher, so there is none to ask for.
if [ "${AEOLUS_HARNESS:-}" = copilot ]; then
  let_end
  exit 0
fi

if printf '%s' "$payload" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true' \
  || aeolus_is_watching || [ -f "$(aeolus_refused_file)" ]; then
  let_end
  exit 0
fi

aeolus_log "$identity" askWatcher 'kept the turn open: no watcher runs'
reason="aeolus: no watcher runs for ${ship_name}, so nothing wakes this session when work arrives: start \"${root}/scripts/aeolus-wait.sh\" as a background task (run_in_background), then end your turn"
printf '{"decision":"block","reason":"%s"}\n' "$(aeolus_json_escape "$reason")"
