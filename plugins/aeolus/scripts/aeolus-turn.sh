#!/usr/bin/env bash
# UserPromptSubmit hook: in a folder a trierarch crews (wakeBy=trierarch), marks
# the turn busy, with when, so the trierarch wakes the session only once it is
# idle again (the Stop hook marks that). Silent; nothing in any other folder.
# Never fails the session.
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

payload="$(cat)"
aeolus_hook_folder "$payload"
identity="$(aeolus_identity_file 2>/dev/null)" || exit 0
[ -f "$identity" ] || exit 0
aeolus_mark_turn "$identity" busy
exit 0
