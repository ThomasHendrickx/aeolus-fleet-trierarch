#!/usr/bin/env bash
# The ship this folder crews, kept in the plugin's data folder.
#
#   aeolus-identity.sh write [--wake-by trierarch [--socket <path>] [--checkout <repository>=<path>]... [--read-only-folder]] <fleetUrl> <shipId> <shipName> [<squadronId>]
#                       the crew token on stdin, never on the command line, which any local user reads (#822);
#                       with --wake-by trierarch, the trierarch wakes the folder's sessions, not a watcher;
#                       with --socket, the folder calls the fleet over the trierarch's socket and keeps only the token's lease;
#                       each --checkout, a read-only checkout the trierarch keeps beside the folder, which the start context names (#1182)
#                       --read-only-folder, the folder is a read-only workspace the trierarch keeps on main, which the start context says (aeolus-fleet#1449)
#   aeolus-identity.sh check-in <interval>   a squadron member keeps its check-in interval: <n>m or <n>h
#   aeolus-identity.sh show     the ship and its fleet (never the token), and whether its lease is pushed; exit 1 when none
#   aeolus-identity.sh turn     the turn marker of a folder a trierarch crews: busy or idle, with when; exit 1 when none
#   aeolus-identity.sh launch   the launch marker of a folder a trierarch crews: the launch id, then what the hooks saw; exit 1 when none
#   aeolus-identity.sh launch clear   forgets the launch marker, before the trierarch starts a launch
#   aeolus-identity.sh store    what the folder's store holds (#756): each delivery id, its state and when, oldest first
#   aeolus-identity.sh path     the identity file of this folder, whether it exists or not
#   aeolus-identity.sh delete   stops the folder's watcher and forgets the ship
set -euo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

file="$(aeolus_identity_file)"
command="${1:-}"

case "$command" in
  write)
    usage="usage: aeolus-identity.sh write [--wake-by trierarch [--socket <path>] [--checkout <repository>=<path>]... [--read-only-folder]] <fleetUrl> <shipId> <shipName> [<squadronId>], the crew token on stdin"
    wake_by=""
    socket=""
    checkouts=()
    read_only_folder=""
    shift
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --wake-by) [ "${2:-}" = trierarch ] || { echo "$usage" >&2; exit 2; }; wake_by=trierarch; shift 2 ;;
        --socket) [ -n "${2:-}" ] || { echo "$usage" >&2; exit 2; }; socket="$2"; shift 2 ;;
        --checkout)
          case "${2:-}" in
            ?*=?*) checkouts+=("$2"); shift 2 ;;
            *) echo "$usage" >&2; exit 2 ;;
          esac
          ;;
        --read-only-folder) read_only_folder=yes; shift ;;
        *) break ;;
      esac
    done
    # Only a trierarch's folder calls over a socket: the trierarch adds the crew token (decision 0026).
    [ -z "$socket" ] || [ "$wake_by" = trierarch ] || { echo "$usage" >&2; exit 2; }
    # Only a trierarch keeps checkouts beside a folder (#1182).
    [ "${#checkouts[@]}" -eq 0 ] || [ "$wake_by" = trierarch ] || { echo "$usage" >&2; exit 2; }
    [ -z "$read_only_folder" ] || [ "$wake_by" = trierarch ] || { echo "$usage" >&2; exit 2; }
    { [ "$#" -eq 3 ] || [ "$#" -eq 4 ]; } || { echo "$usage" >&2; exit 2; }
    IFS= read -r token || true
    [ -n "$token" ] || { echo "$usage" >&2; exit 2; }
    folder="$(aeolus_folder)"
    mkdir -p "$(dirname "$file")"
    umask 077
    printf 'fleetUrl=%s\nshipId=%s\nshipName=%s\n' "${1%/}" "$2" "$3" > "$file.tmp"
    # A folder whose calls go over its trierarch's socket holds no crew token, only the lease it
    # stands for, so its store and reports still tell its crews apart; any other keeps its own.
    if [ -n "$socket" ]; then
      printf 'socket=%s\nlease=%s\n' "$socket" "$(aeolus_lease_key "$token")" >> "$file.tmp"
    else
      printf 'crewToken=%s\n' "$token" >> "$file.tmp"
    fi
    printf 'folder=%s\n' "$folder" >> "$file.tmp"
    # A squadron member keeps its squadron: it checks in at the flagship of that name.
    [ "$#" -eq 4 ] && printf 'squadron=%s\n' "$4" >> "$file.tmp"
    # Its read-only checkouts, one line each: the repository, then where it is.
    # Spelled so an empty list is no unbound variable in the bash 3.2 macOS ships.
    for checkout in ${checkouts[@]+"${checkouts[@]}"}; do
      printf 'checkout=%s\n' "$checkout" >> "$file.tmp"
    done
    [ -n "$read_only_folder" ] && printf 'readOnlyFolder=yes\n' >> "$file.tmp"
    # A trierarch's session: the trierarch wakes it, so the plugin asks for no watcher.
    [ -n "$wake_by" ] && printf 'wakeBy=%s\n' "$wake_by" >> "$file.tmp"
    mv "$file.tmp" "$file"
    echo "aeolus: this folder now crews ${3} (${2}); identity file ${file}"
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
    text="$(aeolus_identity_read "$file")" || { echo "aeolus: this folder crews no ship" >&2; exit 1; }
    umask 077
    { printf '%s\n' "$text" | grep -v '^checkIn=' || true; printf 'checkIn=%s\n' "$2"; } > "$file.tmp"
    mv "$file.tmp" "$file"
    echo "aeolus: check-in interval ${2}"
    ;;
  show)
    if ! text="$(aeolus_identity_read "$file")"; then
      echo "aeolus: this folder crews no ship"
      exit 1
    fi
    echo "ship: $(aeolus_identity_field "$text" shipName) ($(aeolus_identity_field "$text" shipId))"
    echo "fleet: $(aeolus_identity_field "$text" fleetUrl)"
    echo "folder: $(aeolus_identity_field "$text" folder)"
    squadron="$(aeolus_identity_field "$text" squadron)"
    [ -n "$squadron" ] && echo "squadron: ${squadron}"
    check_in="$(aeolus_identity_field "$text" checkIn)"
    [ -n "$check_in" ] && echo "check-in: ${check_in}"
    if aeolus_woken_by_trierarch "$text"; then
      echo "wakes: the trierarch"
    fi
    # The watcher or the wake bridge pushed this lease (#756): the hooks put each message into the turn.
    if aeolus_reports_here "$text"; then
      echo "delivery: pushed"
    fi
    ;;
  turn)
    turn_file="$(aeolus_turn_file)"
    cat "$turn_file" 2>/dev/null || { echo "aeolus: no turn marked yet"; exit 1; }
    ;;
  launch)
    launch_file="$(aeolus_launch_file)"
    if [ "${2:-}" = clear ]; then
      rm -f "$launch_file"
      exit 0
    fi
    cat "$launch_file" 2>/dev/null || { echo "aeolus: no launch marked yet"; exit 1; }
    ;;
  store)
    store_dir="$(aeolus_store_dir)"
    for state_file in "$store_dir"/*.state; do
      [ -f "$state_file" ] || continue
      id="${state_file##*/}"
      printf '%s %s\n' "${id%.state}" "$(cat "$state_file")"
    done
    ;;
  path)
    echo "$file"
    ;;
  delete)
    wake_pid_file="$(aeolus_wake_pid_file)"
    wake_thread_file="$(aeolus_wake_thread_file)"
    if wake_pid="$(head -n 1 "$wake_pid_file" 2>/dev/null)"; then
      aeolus_process_is "$wake_pid" aeolus-codex-wake.sh && kill "$wake_pid" 2>/dev/null || true
      rm -f "$wake_pid_file" "$wake_thread_file"
    fi
    pid_file="$(aeolus_pid_file)"
    if pid="$(head -n 1 "$pid_file" 2>/dev/null)"; then
      aeolus_process_is "$pid" aeolus-wait.sh && kill "$pid" 2>/dev/null || true
      rm -f "$pid_file"
    fi
    aeolus_store_forget
    rm -f "$file" "$(aeolus_refused_file)" "$(aeolus_reported_file)" "$(aeolus_turn_file)" "$(aeolus_turn_reported_file)" "$(aeolus_forced_stop_file)" "$(aeolus_pushed_file)" "$(aeolus_launch_file)" "$(aeolus_waiting_file)" "$(aeolus_model_file)"
    echo "aeolus: this folder crews no ship any more"
    ;;
  *)
    echo "usage: aeolus-identity.sh write|check-in|show|turn|launch|store|path|delete" >&2
    exit 2
    ;;
esac
