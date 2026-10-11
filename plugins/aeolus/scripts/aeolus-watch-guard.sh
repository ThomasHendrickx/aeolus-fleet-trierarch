#!/usr/bin/env bash
# PreToolUse hook on Bash. Refuses to start the watcher in the background while
# one already runs for the folder's ship: the second would only exit 4 at once
# and wake the session with nothing to read. In a folder a trierarch crews
# (wakeBy=trierarch), refuses any watcher: the trierarch wakes the session.
# Silent otherwise. Never fails the session.
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

payload="$(cat)"
printf '%s' "$payload" | grep -q 'aeolus-wait\.sh' || exit 0
printf '%s' "$payload" | grep -Eq '"run_in_background"[[:space:]]*:[[:space:]]*true' || exit 0
aeolus_hook_folder "$payload"
identity="$(aeolus_identity_file 2>/dev/null)" || exit 0
identity_text="$(aeolus_identity_read "$identity")"

if aeolus_woken_by_trierarch "$identity_text"; then
  aeolus_log "$identity" refuseWatcher 'refused: the trierarch wakes the session'
  reason="aeolus: the trierarch wakes $(aeolus_identity_field "$identity_text" shipName); start no watcher and do nothing else"
else
  aeolus_is_watching || exit 0
  aeolus_log "$identity" refuseWatcher 'refused: a watcher runs for this ship'
  reason="aeolus: already running: a watcher runs for $(aeolus_identity_field "$identity_text" shipName); do nothing else"
fi
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$(aeolus_json_escape "$reason")"
