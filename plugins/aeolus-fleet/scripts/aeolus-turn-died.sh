#!/usr/bin/env bash
# StopFailure hook (Claude Code), on every error, Interrupt hook (Codex), and
# SessionEnd hook (Copilot), whose reason error, abort or timeout says the turn
# ended without Stop; Copilot's errorOccurred fires at every model call it
# retries, a turn that recovers too, so it says nothing of the turn.
# The turn ended without Stop, so it died (#756, D3), unless the trierarch
# stopped it for a forced message (decision 0040). On a pushed lease, a confirmed message the turn took
# is kept to hand once more at the next prompt, and one handed once more
# already, whose turn died too, is reported not handled. The session is idle
# again, and the turn is reported so. Says nothing; never fails the session.
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

payload="$(cat)"
hook_event="$(aeolus_json_string "$payload" hook_event_name)"
if [ "$hook_event" = SessionEnd ]; then
  case "$(aeolus_json_string "$payload" reason)" in
    error|abort|timeout) ;;
    *) exit 0 ;;
  esac
fi
aeolus_hook_folder "$payload" || exit 1
identity="$(aeolus_identity_file 2>/dev/null)" || exit 0
identity_text="$(aeolus_identity_read "$identity")" || exit 0
aeolus_reports_here "$identity_text" || exit 0
aeolus_store_drop_older_leases
# The trierarch stopped the turn to hand a forced message over (decision 0040):
# stopping is not dying, so what the turn confirmed stays confirmed, handled
# when the forced turn ends, and the forced prompt follows at once.
forced_stop="$(aeolus_forced_stop_file)"
if [ "$hook_event" = Interrupt ] && [ -f "$forced_stop" ]; then
  rm -f "$forced_stop"
  aeolus_log "$identity" turn 'stopped for a forced message: what the turn took is handled when the forced turn ends'
  aeolus_send_owed "$identity"
  exit 0
fi
error="$(aeolus_json_string "$payload" error)"
[ -n "$error" ] || error="$(aeolus_json_string "$payload" reason)"
aeolus_store_died_turn "$identity" "the turn it was handed once more to died too (${hook_event:-a died turn}${error:+: ${error}})"
aeolus_mark_turn idle
aeolus_log "$identity" turn 'idle: the turn failed'
aeolus_send_owed "$identity"
exit 0
