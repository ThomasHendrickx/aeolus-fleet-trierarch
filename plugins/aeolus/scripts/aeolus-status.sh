#!/usr/bin/env bash
# The status of this folder's ship, answered by the script, not the model, as
# aeolus-trierarch status answers for a trierarch: the plugin's version, the
# ship, its fleet and folder, what wakes the session, whether the lease holds
# and how many deliveries wait. Its fleet calls go through aeolus-fleet.sh, so the crew
# token stays in the identity file and LEASE_ENDED forgets the ship as any
# other call does. Claims nothing.
#
# Exit codes, as aeolus-fleet.sh's:
#   0  the lease holds
#   1  the fleet refused whoami or the inbox check
#   2  this folder crews no ship
#   3  LEASE_ENDED: the operator released the ship, and the plugin forgot it
#   6  no answer from the fleet
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

scripts="$(dirname "$0")"
version="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${scripts}/../.claude-plugin/plugin.json" | head -n 1)"
echo "Version: ${version:-unknown}"

identity="$(aeolus_identity_file)" || exit 2
if ! identity_text="$(aeolus_identity_read "$identity")"; then
  echo "Ship: none: this folder crews no ship; its crew line crews one"
  exit 2
fi
ship="$(aeolus_identity_field "$identity_text" shipName) ($(aeolus_identity_field "$identity_text" shipId))"
fleet_url="$(aeolus_identity_field "$identity_text" fleetUrl)"
folder="$(aeolus_identity_field "$identity_text" folder)"

# Read before whoami: on LEASE_ENDED the plugin forgets the ship and stops its watcher.
if aeolus_woken_by_trierarch "$identity_text"; then
  running="the trierarch wakes this session"
elif aeolus_is_watching; then
  running="the watcher runs"
else
  running="no watcher runs"
fi

answer="$("${scripts}/aeolus-fleet.sh" whoami)"
code=$?
case "$code" in
  0)
    ship="$(aeolus_json_string "$answer" name) ($(aeolus_json_string "$answer" shipId)), type $(aeolus_json_string "$answer" type)"
    lease="holds"
    answer="$("${scripts}/aeolus-fleet.sh" inbox)"
    code=$?
    if [ "$code" -eq 0 ]; then
      waiting="$(printf '%s' "$answer" | sed -n 's/.*"waiting"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
      case "${waiting:-0}" in
        0) inbox="none wait" ;;
        1) inbox="1 delivery waits" ;;
        *) inbox="${waiting} deliveries wait" ;;
      esac
    else
      inbox="unknown: ${answer#aeolus: }"
    fi
    ;;
  3)
    lease="ended: the operator released the ship, and the plugin forgot it"
    inbox="none: the ship was released"
    ;;
  6)
    lease="unknown: no answer from ${fleet_url}"
    inbox="unknown: no answer from the fleet"
    ;;
  *)
    lease="unknown: ${answer#aeolus: }"
    inbox="unknown: the fleet refused whoami"
    ;;
esac

echo "Ship: ${ship}"
echo "Fleet: ${fleet_url}"
echo "Folder: ${folder}"
echo "Running: ${running}"
echo "Lease: ${lease}"
echo "Inbox: ${inbox}"
exit "$code"
