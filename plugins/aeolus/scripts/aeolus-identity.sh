#!/usr/bin/env bash
# The ship this folder crews, kept in the plugin's data folder.
#
#   aeolus-identity.sh write [--wake-by trierarch] <fleetUrl> <shipId> <shipName> <crewToken> [<squadronId>]
#                       with --wake-by trierarch, the trierarch wakes the folder's sessions, not a watcher
#   aeolus-identity.sh check-in <interval>   a squadron member keeps its check-in interval: <n>m or <n>h
#   aeolus-identity.sh show     the ship and its fleet (never the token); exit 1 when none
#   aeolus-identity.sh turn     the turn marker of a folder a trierarch crews: busy or idle, with when; exit 1 when none
#   aeolus-identity.sh path     the identity file of this folder, whether it exists or not
#   aeolus-identity.sh delete   stops the folder's watcher and forgets the ship
set -euo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

file="$(aeolus_identity_file)"
command="${1:-}"

case "$command" in
  write)
    usage="usage: aeolus-identity.sh write [--wake-by trierarch] <fleetUrl> <shipId> <shipName> <crewToken> [<squadronId>]"
    wake_by=""
    if [ "${2:-}" = --wake-by ]; then
      [ "${3:-}" = trierarch ] || { echo "$usage" >&2; exit 2; }
      wake_by=trierarch
      set -- "$1" "${@:4}"
    fi
    { [ "$#" -eq 5 ] || [ "$#" -eq 6 ]; } || { echo "$usage" >&2; exit 2; }
    folder="$(aeolus_folder)"
    mkdir -p "$(dirname "$file")"
    umask 077
    printf 'fleetUrl=%s\nshipId=%s\nshipName=%s\ncrewToken=%s\nfolder=%s\n' "${2%/}" "$3" "$4" "$5" "$folder" > "$file.tmp"
    # A squadron member keeps its squadron: it checks in at the flagship of that name.
    [ "$#" -eq 6 ] && printf 'squadron=%s\n' "$6" >> "$file.tmp"
    # A trierarch's session: the trierarch wakes it, so the plugin asks for no watcher.
    [ -n "$wake_by" ] && printf 'wakeBy=%s\n' "$wake_by" >> "$file.tmp"
    mv "$file.tmp" "$file"
    echo "aeolus: this folder now crews ${4} (${3}); identity file ${file}"
    ;;
  check-in)
    # The interval the flagship's role message gives, so the plugin can remind the member to report.
    case "${2:-}" in
      [1-9]*m|[1-9]*h) ;;
      *) echo "usage: aeolus-identity.sh check-in <n>m|<n>h" >&2; exit 2 ;;
    esac
    case "${2%[mh]}" in
      *[!0-9]*) echo "usage: aeolus-identity.sh check-in <n>m|<n>h" >&2; exit 2 ;;
    esac
    [ -f "$file" ] || { echo "aeolus: this folder crews no ship" >&2; exit 1; }
    umask 077
    { grep -v '^checkIn=' "$file" || true; printf 'checkIn=%s\n' "$2"; } > "$file.tmp"
    mv "$file.tmp" "$file"
    echo "aeolus: check-in interval ${2}"
    ;;
  show)
    if [ ! -f "$file" ]; then
      echo "aeolus: this folder crews no ship"
      exit 1
    fi
    echo "ship: $(aeolus_identity_get "$file" shipName) ($(aeolus_identity_get "$file" shipId))"
    echo "fleet: $(aeolus_identity_get "$file" fleetUrl)"
    echo "folder: $(aeolus_identity_get "$file" folder)"
    squadron="$(aeolus_identity_get "$file" squadron)"
    [ -n "$squadron" ] && echo "squadron: ${squadron}"
    check_in="$(aeolus_identity_get "$file" checkIn)"
    [ -n "$check_in" ] && echo "check-in: ${check_in}"
    if [ "$(aeolus_identity_get "$file" wakeBy)" = trierarch ]; then
      echo "wakes: the trierarch"
    fi
    ;;
  turn)
    turn_file="$(aeolus_turn_file)"
    [ -f "$turn_file" ] || { echo "aeolus: no turn marked yet"; exit 1; }
    cat "$turn_file"
    ;;
  path)
    echo "$file"
    ;;
  delete)
    wake_pid_file="$(aeolus_wake_pid_file)"
    wake_thread_file="$(aeolus_wake_thread_file)"
    if [ -f "$wake_pid_file" ]; then
      wake_pid="$(head -n 1 "$wake_pid_file")"
      aeolus_process_is "$wake_pid" aeolus-codex-wake.sh && kill "$wake_pid" 2>/dev/null || true
      rm -f "$wake_pid_file" "$wake_thread_file"
    fi
    pid_file="$(aeolus_pid_file)"
    if [ -f "$pid_file" ]; then
      pid="$(head -n 1 "$pid_file")"
      aeolus_process_is "$pid" aeolus-wait.sh && kill "$pid" 2>/dev/null || true
      rm -f "$pid_file"
    fi
    rm -f "$file" "$(aeolus_refused_file)" "$(aeolus_reported_file)" "$(aeolus_turn_file)" "$(aeolus_model_file)"
    echo "aeolus: this folder crews no ship any more"
    ;;
  *)
    echo "usage: aeolus-identity.sh write|check-in|show|turn|path|delete" >&2
    exit 2
    ;;
esac
