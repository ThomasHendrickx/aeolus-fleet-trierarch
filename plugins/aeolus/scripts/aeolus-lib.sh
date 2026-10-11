# Shared by every aeolus script: where the plugin keeps a folder's ship, and
# how to read and write it. Sourced, never run. Bash only: on Windows, Claude
# Code runs hooks and the Bash tool through Git Bash.
#
# One ship per folder. The folder is the session's working folder: the folder
# Claude Code started in (CLAUDE_PROJECT_DIR), else the payload's cwd (Codex).
# The SessionStart hook exports it as AEOLUS_FOLDER for every later command of
# the session, so the hook, the watcher and the commands all key the ship by
# the same path, wherever in the folder the session works.

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

# The harness the plugin runs in: AEOLUS_HARNESS (a Codex skill's commands set
# it), else codex in a Codex hook, which has PLUGIN_ROOT, else claude-code.
aeolus_harness() {
  if [ -n "${AEOLUS_HARNESS:-}" ]; then
    printf '%s' "$AEOLUS_HARNESS"
  elif [ -n "${PLUGIN_ROOT:-}" ]; then
    printf codex
  else
    printf claude-code
  fi
}

# Whether the crews folder is known rather than guessed: AEOLUS_CREWS or
# AEOLUS_HARNESS names it, or a hook of either harness runs. A Codex command
# without AEOLUS_HARNESS guesses claude-code, so it must not move (#679).
aeolus_crews_known() {
  [ -n "${AEOLUS_CREWS:-}" ] || [ -n "${AEOLUS_HARNESS:-}" ] || [ -n "${PLUGIN_ROOT:-}" ] || [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]
}

# Where the identities of the harness's sessions live (decision 0015):
# ~/.aeolus/crews/<harness>, outside the plugin's data folder, so uninstalling
# the plugin cannot delete them (#658). AEOLUS_CREWS names another folder, as
# the trierarch does. A plugin from before kept them in <data>/ships: the first
# script that knows its harness moves them here and leaves a link there.
aeolus_ships_dir() {
  local crews="${AEOLUS_CREWS:-${HOME:?}/.aeolus/crews/$(aeolus_harness)}"
  aeolus_move_ships "$crews"
  printf '%s' "$crews"
}

# Moves what an older plugin kept in <data>/ships to the crews folder, then
# links <data>/ships to the crews folder so a session still on an older plugin
# finds its identity. A file the crews folder already holds wins: the old one
# stays, and so does <data>/ships without a link. Deleting the data folder
# deletes the link, never what it points to. Moves only when the crews folder
# is known, never guessed. Never fails its caller.
aeolus_move_ships() {
  local crews="$1" data old entry
  data="${AEOLUS_DATA:-${PLUGIN_DATA:-${CLAUDE_PLUGIN_DATA:-}}}"
  if [ ! -d "$crews" ]; then
    (umask 077 && mkdir -p "$crews") 2>/dev/null || return 0
  fi
  aeolus_crews_known || return 0
  [ -n "$data" ] && [ -d "$data" ] || return 0
  old="$data/ships"
  if [ -d "$old" ] && [ ! -L "$old" ]; then
    for entry in "$old"/*; do
      [ -e "$entry" ] || continue
      [ -e "$crews/${entry##*/}" ] || mv "$entry" "$crews/" 2>/dev/null || true
    done
    rmdir "$old" 2>/dev/null || return 0
  fi
  [ -e "$old" ] || [ -L "$old" ] || ln -s "$crews" "$old" 2>/dev/null || true
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

# The turn marker of a crewed folder: busy or idle, with when. The trierarch, or
# else the plugin's own watcher, wakes the session only while it is idle.
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

# Writes the turn marker, busy or idle with the time in UTC.
aeolus_mark_turn() {
  local state="$1" file
  file="$(aeolus_turn_file)" || return 0
  printf '%s %s\n' "$state" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$file.tmp" && mv "$file.tmp" "$file"
}

# Whether the turn marker says the session is idle. No marker is not idle: the
# session has not ended a turn yet.
aeolus_is_idle() {
  local file
  file="$(aeolus_turn_file)" || return 1
  [ -f "$file" ] && [ "$(cut -d ' ' -f 1 "$file")" = idle ]
}

# What the watcher saw of the waiting count: the count, and 1 when a wake is
# owed for a rise in it, else 0. Kept across watchers, so a watcher started
# again does not wake the session for what it already woke it for.
aeolus_waiting_file() {
  local folder dir
  folder="$(aeolus_folder)" || return 1
  dir="$(aeolus_ships_dir)" || return 1
  printf '%s/%s.waiting' "$dir" "$(aeolus_key "$folder")"
}

# When a squadron member last reported, or was last reminded to: seconds since
# the epoch. The report reminder counts its check-in interval from it.
aeolus_reported_file() {
  local folder dir
  folder="$(aeolus_folder)" || return 1
  dir="$(aeolus_ships_dir)" || return 1
  printf '%s/%s.reported' "$dir" "$(aeolus_key "$folder")"
}

# The model a hook last saw the session run, for aeolus-fleet.sh to state on
# every send: Codex names its active model in each hook payload.
aeolus_model_file() {
  local folder dir
  folder="$(aeolus_folder)" || return 1
  dir="$(aeolus_ships_dir)" || return 1
  printf '%s/%s.model' "$dir" "$(aeolus_key "$folder")"
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

# The plugin's log, in the trierarch's log format: one JSON object per line,
# an action the watcher, a hook or the Codex wake bridge took for a ship and how
# it came out (time, shipId, shipName, action, outcome, and next for a
# failure). One log per plugin data folder, as the trierarch keeps one per
# machine; it outlasts the ships it names, so forgetting a ship keeps what was
# logged of it.
aeolus_log_file() {
  local data
  data="$(aeolus_data)" || return 1
  printf '%s/logs/aeolus.log' "$data"
}

# The plugin log's size limit in bytes. A log that reached it moves aside as
# aeolus.log.1, replacing an older one, before the next record starts a new
# log: the plugin keeps at most about twice the limit.
AEOLUS_LOG_MAX_BYTES="${AEOLUS_LOG_MAX_BYTES:-1048576}"

# Moves the log aside once it reached its limit. One writer moves it: the
# others, finding the lock taken, append on, and the one holding the lock looks
# at the size again, so a log just moved aside by another is not moved twice.
# A lock older than a minute was left by a writer stopped while moving it.
aeolus_log_rotate() {
  local file="$1" size
  [ -f "$file" ] || return 0
  size="$(wc -c 2>/dev/null < "$file")" || return 0
  [ "${size// /}" -ge "$AEOLUS_LOG_MAX_BYTES" ] || return 0
  [ -z "$(find "${file}.lock" -maxdepth 0 -mmin +1 2>/dev/null)" ] || rmdir "${file}.lock" 2>/dev/null
  mkdir "${file}.lock" 2>/dev/null || return 0
  size="$(wc -c 2>/dev/null < "$file")" || size=0
  [ "${size// /}" -lt "$AEOLUS_LOG_MAX_BYTES" ] || mv -f "$file" "${file}.1" 2>/dev/null
  rmdir "${file}.lock" 2>/dev/null
  return 0
}

# Appends one record for the ship of an identity file: the action, its outcome,
# and for a failure what happens next. Logs nothing without the identity file,
# and never fails its caller. Never the crew token.
aeolus_log() {
  local identity="$1" action="$2" outcome="$3" next="${4:-}" file record
  [ -f "$identity" ] || return 0
  file="$(aeolus_log_file 2>/dev/null)" || return 0
  mkdir -p "$(dirname "$file")" 2>/dev/null || return 0
  aeolus_log_rotate "$file"
  record="{\"time\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
  record="${record},\"shipId\":\"$(aeolus_json_escape "$(aeolus_identity_get "$identity" shipId)")\""
  record="${record},\"shipName\":\"$(aeolus_json_escape "$(aeolus_identity_get "$identity" shipName)")\""
  record="${record},\"action\":\"${action}\",\"outcome\":\"$(aeolus_json_escape "$outcome")\""
  [ -z "$next" ] || record="${record},\"next\":\"$(aeolus_json_escape "$next")\""
  # One write of a short line to a file opened for appending: concurrent hooks and watchers never interleave.
  printf '%s}\n' "$record" >> "$file" 2>/dev/null || true
}

# One field of an identity file: fleetUrl, shipId, shipName, crewToken or folder.
aeolus_identity_get() {
  local file="$1" field="$2"
  sed -n "s/^${field}=//p" "$file" | head -n 1
}

# The crew token the identity file holds now, or nothing once it is gone: the
# folder may have been crewed again since a script read it.
aeolus_identity_token() {
  local file="$1"
  [ -f "$file" ] || return 0
  aeolus_identity_get "$file" crewToken
}

# The crew token as the bearer, a curl config line for `curl -K -` to read on
# stdin: printf is a builtin, so the token reaches no command line, which any
# process of the same user can read (ps). Prints nothing without a token.
aeolus_bearer_config() {
  [ -z "$1" ] || printf 'header = "authorization: Bearer %s"\n' "$1"
}

# A body as a curl config line for `curl -K -`, for the same reason: register's
# body holds the crew line's secret. Within the quotes curl undoes \\, \", \n,
# \r and \t. Prints nothing without a body.
aeolus_body_config() {
  local body="$1"
  [ -n "$body" ] || return 0
  body="${body//\\/\\\\}"
  body="${body//\"/\\\"}"
  body="${body//$'\n'/\\n}"
  body="${body//$'\r'/\\r}"
  body="${body//$'\t'/\\t}"
  printf 'data-binary = "%s"\n' "$body"
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
