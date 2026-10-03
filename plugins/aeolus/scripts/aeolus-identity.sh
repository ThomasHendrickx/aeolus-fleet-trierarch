#!/usr/bin/env bash
# The ship this folder crews, kept in the plugin's data folder.
#
#   aeolus-identity.sh write <fleetUrl> <shipId> <shipName> <crewToken> [<squadronId>]
#   aeolus-identity.sh show     the ship, its fleet and the file (never the token); exit 1 when none
#   aeolus-identity.sh path     the identity file of this folder, whether it exists or not
#   aeolus-identity.sh delete   stops the folder's watcher and forgets the ship
set -euo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

file="$(aeolus_identity_file)"
command="${1:-}"

case "$command" in
  write)
    { [ "$#" -eq 5 ] || [ "$#" -eq 6 ]; } || { echo "usage: aeolus-identity.sh write <fleetUrl> <shipId> <shipName> <crewToken> [<squadronId>]" >&2; exit 2; }
    folder="$(aeolus_folder)"
    mkdir -p "$(dirname "$file")"
    umask 077
    printf 'fleetUrl=%s\nshipId=%s\nshipName=%s\ncrewToken=%s\nfolder=%s\n' "${2%/}" "$3" "$4" "$5" "$folder" > "$file.tmp"
    # A squadron member keeps its squadron: it checks in at the flagship of that name.
    [ "$#" -eq 6 ] && printf 'squadron=%s\n' "$6" >> "$file.tmp"
    mv "$file.tmp" "$file"
    echo "aeolus: this folder now crews ${4} (${3}); identity file ${file}"
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
    echo "identity file: ${file} (the crew token is its crewToken line)"
    ;;
  path)
    echo "$file"
    ;;
  delete)
    wake_pid_file="$(aeolus_wake_pid_file)"
    wake_thread_file="$(aeolus_wake_thread_file)"
    if [ -f "$wake_pid_file" ]; then
      wake_pid="$(head -n 1 "$wake_pid_file")"
      [ -n "$wake_pid" ] && kill "$wake_pid" 2>/dev/null || true
      rm -f "$wake_pid_file" "$wake_thread_file"
    fi
    pid_file="$(aeolus_pid_file)"
    if [ -f "$pid_file" ]; then
      pid="$(head -n 1 "$pid_file")"
      [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
      rm -f "$pid_file"
    fi
    rm -f "$file"
    echo "aeolus: this folder crews no ship any more"
    ;;
  *)
    echo "usage: aeolus-identity.sh write|show|path|delete" >&2
    exit 2
    ;;
esac
