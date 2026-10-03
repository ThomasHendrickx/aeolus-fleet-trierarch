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

# One field of an identity file: fleetUrl, shipId, shipName, crewToken or folder.
aeolus_identity_get() {
  local file="$1" field="$2"
  sed -n "s/^${field}=//p" "$file" | head -n 1
}

# Whether a live watcher holds the lock: its pid file names a running process.
aeolus_is_watching() {
  local pid_file pid
  pid_file="$(aeolus_pid_file)" || return 1
  [ -f "$pid_file" ] || return 1
  pid="$(head -n 1 "$pid_file")"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# Text as a JSON string's contents: backslashes, quotes and newlines escaped.
aeolus_json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'NR > 1 { printf "\\n" } { printf "%s", $0 }'
}
