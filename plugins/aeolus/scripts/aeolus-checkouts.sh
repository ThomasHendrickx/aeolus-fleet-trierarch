#!/usr/bin/env bash
# The read-only checkouts the trierarch keeps beside a folder it crews (#1182).
#
#   aeolus-checkouts.sh refresh   asks the trierarch, over the ship's socket, to bring each checkout
#                                 to the latest main of its repository; prints its answer as JSON:
#                                 each checkout's repository with the revision it now holds, or why it could not
#
# Exit codes:
#   0  done: the trierarch's answer is printed
#   1  the trierarch refused: its code and message are printed
#   2  this folder crews no ship, no trierarch crews it, or the call is not one of these
#   6  no answer from the trierarch
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

[ "${1:-}" = refresh ] || { echo "usage: aeolus-checkouts.sh refresh" >&2; exit 2; }

identity="$(aeolus_identity_file)" || exit 2
if ! identity_text="$(aeolus_identity_read "$identity")"; then
  echo "aeolus: this folder crews no ship"
  exit 2
fi
socket="$(aeolus_identity_field "$identity_text" socket)"
if [ -z "$socket" ]; then
  echo "aeolus: no trierarch crews this folder, so none keeps checkouts for it"
  exit 2
fi

# A refresh fetches each repository: it may take a while.
answer="$(curl -sS --max-time 300 -w '\n%{http_code}' -X POST --unix-socket "$socket" "http://trierarch/trierarch/checkouts/refresh" 2>/dev/null)"
status="$(printf '%s' "$answer" | tail -n 1)"
body="$(printf '%s' "$answer" | sed '$d')"
if [ -z "$status" ] || [ "$status" = 000 ]; then
  echo "aeolus: no answer from the trierarch at ${socket}"
  exit 6
fi
if [ "$status" != 200 ]; then
  echo "aeolus: the trierarch refused the refresh: $(aeolus_json_string "$body" code): $(aeolus_json_string "$body" message)"
  exit 1
fi
printf '%s\n' "$body"
