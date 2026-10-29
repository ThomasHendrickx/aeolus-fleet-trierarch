#!/usr/bin/env bash
# PreToolUse hook, on every tool (#756): when the watcher handed a message to
# this session, the first tool call of the turn confirms it. The hook
# acknowledges the message to the fleet and, only if that succeeded, denies
# the tool call with the message as its reason, so the model reads it before
# anything it does runs. A ping goes in without an ack: its pong confirms it.
# When the ack is refused the tool call runs, and the model never sees the
# message. Silent with nothing handed, in a folder that crews no ship, and in
# Codex, whose task receives for itself. Silent too at a sub-agent's tool call,
# which names its agent: the reason would go into the sub-agent's context, not
# the session's turn, so the message waits for the turn's own tool call, Stop
# or prompt (aeolus-fleet#1016). Never fails the session.
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

payload="$(cat)"
! aeolus_codex_hook || exit 0
aeolus_hook_folder "$payload" || exit 1
[ -z "$(aeolus_json_string "$payload" agent_id)" ] || exit 0
identity="$(aeolus_identity_file 2>/dev/null)" || exit 0
identity_text="$(aeolus_identity_read "$identity")" || exit 0

root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
denied='aeolus: this tool call did not run: a message came in first. Read it, then go on, and make the call again if you still need it.'
text="$(aeolus_put_into_turn "$identity" "$(aeolus_identity_field "$identity_text" shipName)" "$root" "${denied}"$'\n\n')" || exit 0
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$(aeolus_json_escape "${text%x}")"
