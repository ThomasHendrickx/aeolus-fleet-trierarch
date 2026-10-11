#!/usr/bin/env bash
# UserPromptSubmit hook: in a crewed folder, marks the turn busy, with when, so
# the trierarch, or else the watcher, wakes the session only once it is idle
# again (the Stop hook marks that). Silent. Never fails the session.
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

payload="$(cat)"
aeolus_hook_folder "$payload"
identity="$(aeolus_identity_file 2>/dev/null)" || exit 0
aeolus_identity_read "$identity" >/dev/null || exit 0
aeolus_mark_turn busy
aeolus_log "$identity" turn 'busy: a prompt was submitted'
exit 0
