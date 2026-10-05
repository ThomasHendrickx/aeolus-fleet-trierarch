#!/usr/bin/env bash
# PreToolUse hook on Bash. Refuses to start the watcher in the background while
# one already runs for the folder's ship: the second would only exit 4 at once
# and wake the session with nothing to read. Silent otherwise. Never fails the
# session.
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

payload="$(cat)"
printf '%s' "$payload" | grep -q 'aeolus-wait\.sh' || exit 0
printf '%s' "$payload" | grep -Eq '"run_in_background"[[:space:]]*:[[:space:]]*true' || exit 0
aeolus_hook_folder "$payload"
aeolus_is_watching || exit 0

identity="$(aeolus_identity_file 2>/dev/null)" || exit 0
ship_name="$(aeolus_identity_get "$identity" shipName)"
reason="aeolus: already running: a watcher runs for ${ship_name}; do nothing else"
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$(aeolus_json_escape "$reason")"
