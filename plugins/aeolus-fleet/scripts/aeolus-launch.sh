#!/usr/bin/env bash
# SessionStart, PreToolUse and StopFailure hook: in a session the trierarch
# started for a launch (AEOLUS_LAUNCH, its launch id), marks what the session
# did in its launch window (#490), so the trierarch reads it instead of the
# screen: started, with the transcript its harness keeps; active at the first
# tool call; refused when a turn failed because the model was not found (Claude
# Code's StopFailure), with the model id its message names. Each with when. A
# marker of another launch starts over, so nothing from an earlier session
# counts. Silent without a launch id, and in a folder that crews no ship. Never
# fails the session.
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

launch="${AEOLUS_LAUNCH:-}"
[ -n "$launch" ] || exit 0
payload="$(cat)"
aeolus_hook_folder "$payload" || exit 1
identity="$(aeolus_identity_file 2>/dev/null)" || exit 0
aeolus_identity_read "$identity" >/dev/null || exit 0
file="$(aeolus_launch_file 2>/dev/null)" || exit 0

if [ "$(head -n 1 "$file" 2>/dev/null)" != "launch ${launch}" ]; then
  printf 'launch %s\n' "$launch" > "$file.tmp" && mv "$file.tmp" "$file"
fi

# Appends an event once per launch, with when and what it carries.
mark() {
  local event="$1" detail="${2:-}"
  grep -q "^${event} " "$file" 2>/dev/null && return 0
  printf '%s %s%s\n' "$event" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${detail:+ $detail}" >> "$file"
}

case "$(aeolus_json_string "$payload" hook_event_name)" in
  SessionStart) mark started "$(aeolus_json_string "$payload" transcript_path)" ;;
  PreToolUse) mark active ;;
  StopFailure)
    # Its input names no model, so the id is the one its message names, when it names one.
    if [ "$(aeolus_json_string "$payload" error)" = model_not_found ]; then
      mark refused "$(aeolus_json_string "$payload" last_assistant_message | sed -E -n 's/.*the selected model \(([^()[:space:]]+)\).*/\1/p')"
    fi
    ;;
esac
exit 0
