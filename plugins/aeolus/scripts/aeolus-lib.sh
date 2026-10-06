# Shared by every aeolus script: where the plugin keeps a folder's ship, and
# how to read and write it. Sourced, never run. Bash only: on Windows, Claude
# Code runs hooks and the Bash tool through Git Bash.
#
# One ship per folder. The folder is the session's working folder as Claude
# Code reports it: the SessionStart hook reads it from its payload's cwd and
# exports it as AEOLUS_FOLDER for every later command of the session, so the
# hook, the watcher and the commands all key the ship by the same path.

# The plugin's data folder: ${CLAUDE_PLUGIN_DATA} or ${PLUGIN_DATA} in a hook,
# AEOLUS_DATA in a session's commands.
aeolus_data() {
  local data="${AEOLUS_DATA:-${PLUGIN_DATA:-${CLAUDE_PLUGIN_DATA:-}}}"
  if [ -z "$data" ]; then
    echo "aeolus: no plugin data folder; start a new session so the aeolus SessionStart hook can set it up" >&2
    return 1
  fi
  printf '%s' "$data"
}

# The session's working folder: AEOLUS_FOLDER (set by the hook), else the
# project folder a Claude hook runs in, else the current Codex folder.
aeolus_folder() {
  local folder="${AEOLUS_FOLDER:-${CLAUDE_PROJECT_DIR:-}}"
  [ -n "$folder" ] || folder="$(pwd -P)"
  if [ -z "$folder" ]; then
    echo "aeolus: no working folder; start a new session so the aeolus SessionStart hook can set it up" >&2
    return 1
  fi
  if [ -d "$folder" ]; then
    folder="$(cd "$folder" && pwd -P)" || return 1
  fi
  printf '%s' "$folder"
}

aeolus_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -c1-32
  else
    shasum -a 256 | cut -c1-32
  fi
}

# The key of a folder: the start of the SHA-256 of its path. The one place a
# folder becomes a file name.
aeolus_key() {
  printf '%s' "$1" | aeolus_sha256
}

aeolus_ships_dir() {
  local data
  data="$(aeolus_data)" || return 1
  printf '%s/ships' "$data"
}

# The identity file of the session's folder: fleet URL, ship id, ship name,
# crew token and the folder, one key=value per line. Never the secret.
aeolus_identity_file() {
  local folder dir
  folder="$(aeolus_folder)" || return 1
  dir="$(aeolus_ships_dir)" || return 1
  printf '%s/%s.identity' "$dir" "$(aeolus_key "$folder")"
}

# The watcher's lock: the pid of the aeolus-wait running for the folder's ship.
aeolus_pid_file() {
  local folder dir
  folder="$(aeolus_folder)" || return 1
  dir="$(aeolus_ships_dir)" || return 1
  printf '%s/%s.watch.pid' "$dir" "$(aeolus_key "$folder")"
}

# Marks that the fleet refused the folder's crew token to the watcher, so the
# Stop hook does not ask for a watcher that would only be refused again. A
# watcher that reaches the fleet with the token clears it.
aeolus_refused_file() {
  local folder dir
  folder="$(aeolus_folder)" || return 1
  dir="$(aeolus_ships_dir)" || return 1
  printf '%s/%s.refused' "$dir" "$(aeolus_key "$folder")"
}

# When a squadron member last reported, or was last reminded to: seconds since
# the epoch. The report reminder counts its check-in interval from it.
# The turn marker of a folder a trierarch crews: busy or idle, with when.
aeolus_turn_file() {
  local folder dir
  folder="$(aeolus_folder)" || return 1
  dir="$(aeolus_ships_dir)" || return 1
  printf '%s/%s.turn' "$dir" "$(aeolus_key "$folder")"
}

# Whether the folder's identity says the trierarch wakes its sessions
# (wakeBy=trierarch): then the plugin asks for no watcher of its own.
aeolus_woken_by_trierarch() {
  local identity="$1"
  [ "$(aeolus_identity_get "$identity" wakeBy)" = trierarch ]
}

# Writes the turn marker, busy or idle with the time in UTC, for a folder a
# trierarch crews; nothing for any other folder.
aeolus_mark_turn() {
  local identity="$1" state="$2" file
  aeolus_woken_by_trierarch "$identity" || return 0
  file="$(aeolus_turn_file)" || return 0
  printf '%s %s\n' "$state" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$file.tmp" && mv "$file.tmp" "$file"
}

aeolus_reported_file() {
  local folder dir
  folder="$(aeolus_folder)" || return 1
  dir="$(aeolus_ships_dir)" || return 1
  printf '%s/%s.reported' "$dir" "$(aeolus_key "$folder")"
}

# The Codex wake bridge process and the task it wakes. These are separate from
# the inner inbox watcher's pid so a newer task for the folder can replace an
# older bridge cleanly.
aeolus_wake_pid_file() {
  local folder dir
  folder="$(aeolus_folder)" || return 1
  dir="$(aeolus_ships_dir)" || return 1
  printf '%s/%s.wake.pid' "$dir" "$(aeolus_key "$folder")"
}

aeolus_wake_thread_file() {
  local folder dir
  folder="$(aeolus_folder)" || return 1
  dir="$(aeolus_ships_dir)" || return 1
  printf '%s/%s.wake.thread' "$dir" "$(aeolus_key "$folder")"
}

aeolus_wake_log_file() {
  local folder dir
  folder="$(aeolus_folder)" || return 1
  dir="$(aeolus_ships_dir)" || return 1
  printf '%s/%s.wake.log' "$dir" "$(aeolus_key "$folder")"
}

# One field of an identity file: fleetUrl, shipId, shipName, crewToken or folder.
aeolus_identity_get() {
  local file="$1" field="$2"
  sed -n "s/^${field}=//p" "$file" | head -n 1
}

# Whether a pid belongs to one of this plugin's scripts. A pid file alone is
# not ownership: the operating system may have reused the number.
aeolus_process_is() {
  local pid="$1" script="$2" command
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  command="$(ps -p "$pid" -o command= 2>/dev/null || ps -p "$pid" -f 2>/dev/null)" || return 1
  case "$command" in
    *"/$script"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Whether a live watcher holds the lock: its pid file names this watcher.
aeolus_is_watching() {
  local pid_file pid
  pid_file="$(aeolus_pid_file)" || return 1
  [ -f "$pid_file" ] || return 1
  pid="$(head -n 1 "$pid_file")"
  aeolus_process_is "$pid" aeolus-wait.sh
}

# Text as a JSON string's contents: backslashes, quotes and newlines escaped.
aeolus_json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'NR > 1 { printf "\\n" } { printf "%s", $0 }'
}

# One string field of a hook's JSON payload, its escapes undone.
aeolus_json_string() {
  printf '%s' "$1" | tr -d '\n' | sed -E -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"(([^\"\\\\]|\\\\.)*)\".*/\\1/p" | sed -e 's/\\"/"/g' -e 's/\\\\/\\/g'
}

# A hook's folder: Claude Code's project folder, else the payload's cwd. The
# session's working folder may have moved; the project folder has not.
aeolus_hook_folder() {
  [ -n "${AEOLUS_FOLDER:-}${CLAUDE_PROJECT_DIR:-}" ] || AEOLUS_FOLDER="$(aeolus_json_string "$1" cwd)"
  export AEOLUS_FOLDER
}
