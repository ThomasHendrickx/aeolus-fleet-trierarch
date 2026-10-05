#!/usr/bin/env bash
# PostToolUse hook, after every tool call. A squadron member reports at least
# once per check-in interval; in a long run that is easy to forget. This hook
# counts a report through the report tool or the fleet's REST door, and once an
# interval passes without one it reminds the session, once per interval. Only
# squadron members have an interval (a plain ship gets no reminders). Silent
# otherwise. Never fails the session.
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

SECONDS_PER_MINUTE=60
SECONDS_PER_HOUR=3600

payload="$(cat)"
aeolus_hook_folder "$payload"
identity="$(aeolus_identity_file 2>/dev/null)" || exit 0
[ -f "$identity" ] || exit 0
squadron="$(aeolus_identity_get "$identity" squadron)"
check_in="$(aeolus_identity_get "$identity" checkIn)"
[ -n "$squadron" ] && [ -n "$check_in" ] || exit 0

reported_file="$(aeolus_reported_file)" || exit 0
now="$(date +%s)"
tool_name="$(aeolus_json_string "$payload" tool_name)"
case "$tool_name" in
  mcp__*__report)
    echo "$now" > "$reported_file"
    exit 0
    ;;
esac
if printf '%s' "$payload" | grep -q '/api/v1/ship/report'; then
  echo "$now" > "$reported_file"
  exit 0
fi

if [ ! -f "$reported_file" ]; then
  echo "$now" > "$reported_file"
  exit 0
fi
case "$check_in" in
  *h) interval=$(( ${check_in%h} * SECONDS_PER_HOUR )) ;;
  *) interval=$(( ${check_in%m} * SECONDS_PER_MINUTE )) ;;
esac
last="$(head -n 1 "$reported_file")"
case "$last" in
  ''|*[!0-9]*) last=0 ;;
esac
[ $(( now - last )) -ge "$interval" ] || exit 0

echo "$now" > "$reported_file"
ship_name="$(aeolus_identity_get "$identity" shipName)"
reminder="aeolus: ${check_in}, the check-in interval of the squadron ${squadron}, passed since ${ship_name} last reported: report what you are doing now with the report call, such as {\"state\":\"working\",\"note\":\"reviewing PR 89\"}, then go on"
printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s"}}\n' "$(aeolus_json_escape "$reminder")"
