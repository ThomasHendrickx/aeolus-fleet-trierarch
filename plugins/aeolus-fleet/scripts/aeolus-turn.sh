#!/usr/bin/env bash
# UserPromptSubmit hook: in a crewed folder, marks the turn busy, with when, so
# the trierarch, or else the watcher, wakes the session only once it is idle
# again (the Stop hook marks that). Never fails the session.
#
# The prompt that starts a turn confirms a message handed to the session
# (#756): in Codex the prompt the wake bridge queues, in either harness a
# person's. It acknowledges the message, and only if that succeeded adds it to
# the turn's context. On a pushed lease it also reports the turn busy, and puts
# in a message a died turn left to hand once more, as handed before (D3).
# Claude Code also fires it for a prompt injected into a running turn (a queued
# command or task notification), so a prompt never closes a turn: only Stop
# ends one, and StopFailure or Interrupt (aeolus-turn-died.sh) a died one
# (#846). Otherwise silent.
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

payload="$(cat)"
aeolus_hook_folder "$payload" || exit 1
identity="$(aeolus_identity_file 2>/dev/null)" || exit 0
identity_text="$(aeolus_identity_read "$identity")" || exit 0
if aeolus_reports_here "$identity_text"; then
  aeolus_store_drop_older_leases
  aeolus_send_owed "$identity"
fi
# The forced turn starts: a stop after this one is a died turn again.
rm -f "$(aeolus_forced_stop_file)"
aeolus_mark_turn busy
aeolus_log "$identity" turn 'busy: a prompt was submitted'
aeolus_report_turn "$identity_text"

root="${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}}"
ship_name="$(aeolus_identity_field "$identity_text" shipName)"
text="$(aeolus_put_into_turn "$identity" "$ship_name" "$root" '')" \
  || { aeolus_reports_here "$identity_text" && text="$(aeolus_put_once_more "$identity" "$ship_name" "$root" '')"; } \
  || exit 0
printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' "$(aeolus_json_escape "${text%x}")"
