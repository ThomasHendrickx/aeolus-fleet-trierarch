#!/usr/bin/env bash
# How many deliveries wait for this folder's ship now, from the fleet's inbox
# check, which claims nothing. Prints the fleet's answer.
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

identity="$(aeolus_identity_file)" || exit 2
[ -f "$identity" ] || { echo "aeolus: this folder crews no ship"; exit 2; }
aeolus_bearer_config "$(aeolus_identity_get "$identity" crewToken)" \
  | curl -K - -sS --fail-with-body --max-time 15 -X POST "$(aeolus_identity_get "$identity" fleetUrl)/api/v1/ship/inbox" \
    -H 'content-type: application/json' -d '{}'
status=$?
echo
exit "$status"
