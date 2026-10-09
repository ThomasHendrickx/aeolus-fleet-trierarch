#!/usr/bin/env bash
# PreToolUse hook on Bash. When a command calls aeolus-fleet.sh, records the
# model the payload names (Codex states its active model in every hook
# payload), so the script's sends state the model running now, even after a
# switch. Records nothing for a payload without a model. Silent. Never fails
# the session.
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

payload="$(cat)"
printf '%s' "$payload" | grep -q 'aeolus-fleet\.sh' || exit 0
# The payload's own key only: inside the command's text its quotes are escaped.
model="$(printf '%s' "$payload" | tr -d '\n' | sed -E -n 's/^.*"model"[[:space:]]*:[[:space:]]*"([^"\\]+)".*$/\1/p')"
[ -n "$model" ] || exit 0
aeolus_hook_folder "$payload"
file="$(aeolus_model_file 2>/dev/null)" || exit 0
[ -d "$(dirname "$file")" ] || exit 0
printf '%s\n' "$model" > "$file.tmp" && mv "$file.tmp" "$file"
exit 0
