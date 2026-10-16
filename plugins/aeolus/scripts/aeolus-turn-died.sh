#!/usr/bin/env bash
# StopFailure hook (Claude Code), on every error, and Interrupt hook (Codex):
# the turn ended without Stop, so it died (#756, D3). On a pushed lease, a confirmed message the turn took
# is kept to hand once more at the next prompt, and one handed once more
# already, whose turn died too, is reported not handled. The session is idle
# again, and the turn is reported so. Says nothing; never fails the session.
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

payload="$(cat)"
aeolus_hook_folder "$payload"
identity="$(aeolus_identity_file 2>/dev/null)" || exit 0
identity_text="$(aeolus_identity_read "$identity")" || exit 0
aeolus_reports_here "$identity_text" || exit 0
aeolus_store_drop_older_leases
hook_event="$(aeolus_json_string "$payload" hook_event_name)"
error="$(aeolus_json_string "$payload" error)"
aeolus_store_died_turn "$identity" "the turn it was handed once more to died too (${hook_event:-a died turn}${error:+: ${error}})"
aeolus_mark_turn idle
aeolus_log "$identity" turn 'idle: the turn failed'
aeolus_send_owed "$identity"
exit 0
