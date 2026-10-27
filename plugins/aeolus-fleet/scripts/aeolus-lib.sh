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
    echo "aeolus: no plugin data folder; start a new session so the Aeolus Fleet SessionStart hook can set it up" >&2
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
    echo "aeolus: no working folder; start a new session so the Aeolus Fleet SessionStart hook can set it up" >&2
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
# it), else codex in a Codex hook, which has PLUGIN_ROOT, else the harness whose
# crews folder holds the folder's identity, claude-code first (#687), else
# claude-code.
aeolus_harness() {
  local folder key
  if [ -n "${AEOLUS_HARNESS:-}" ]; then
    printf '%s' "$AEOLUS_HARNESS"
  elif [ -n "${PLUGIN_ROOT:-}" ]; then
    printf codex
  else
    folder="$(aeolus_folder 2>/dev/null)" || folder=""
    key="$(aeolus_key "$folder")"
    if [ -n "$folder" ] && [ ! -f "${HOME:?}/.aeolus/crews/claude-code/$key.identity" ] && [ -f "$HOME/.aeolus/crews/codex/$key.identity" ]; then
      printf codex
    else
      printf claude-code
    fi
  fi
}

# The harness a register states and crews for, where no identity can tell it
# yet: AEOLUS_HARNESS, else codex in a Codex hook, else claude-code in Claude
# Code, which sets CLAUDECODE in every shell it starts and CLAUDE_PLUGIN_ROOT in
# its hooks, else codex: the plugin runs in these two only, and a Codex skill's
# command that left out AEOLUS_HARNESS sets none of them (#711).
aeolus_register_harness() {
  if [ -n "${AEOLUS_HARNESS:-}" ]; then
    printf '%s' "$AEOLUS_HARNESS"
  elif [ -n "${PLUGIN_ROOT:-}" ]; then
    printf codex
  elif [ -n "${CLAUDECODE:-}" ] || [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
    printf claude-code
  else
    printf codex
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

# The mark of a forced stop (decision 0040): the trierarch stops a busy turn to
# hand a forced message over, and stopping is not dying. Codex's Interrupt hook
# then leaves what the stopped turn confirmed confirmed, handled when the forced
# turn ends. The prompt that starts the forced turn, or a turn end, clears it.
aeolus_forced_stop_file() {
  local file
  file="$(aeolus_turn_file)" || return 1
  printf '%s.forcedStop' "$file"
}

# How many forced deliveries the fleet's inbox check answered, not handed over
# yet; 0 when it says none. <inbox answer>
aeolus_inbox_forced() {
  local forced
  forced="$(printf '%s' "$1" | sed -n 's/.*"forced"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
  printf '%s' "${forced:-0}"
}

# The launch marker of a crewed folder (#490): the launch id the trierarch
# started the session for, then what its hooks saw of that launch, with when.
aeolus_launch_file() {
  local folder dir
  folder="$(aeolus_folder)" || return 1
  dir="$(aeolus_ships_dir)" || return 1
  printf '%s/%s.launch' "$dir" "$(aeolus_key "$folder")"
}

# Whether an identity's text says the trierarch wakes its sessions
# (wakeBy=trierarch): then the plugin asks for no watcher of its own.
aeolus_woken_by_trierarch() {
  [ "$(aeolus_identity_field "$1" wakeBy)" = trierarch ]
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
  local file state
  file="$(aeolus_turn_file)" || return 1
  state="$(cut -d ' ' -f 1 "$file" 2>/dev/null)" || return 1
  [ "$state" = idle ]
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

# The questions the folder's ship asked: each question's uuid and the selector
# of the ship it asked, one per line, so a withdrawal or replacement goes to the
# ship that was asked (decision 0038), whoever owns the ship by then.
aeolus_questions_file() {
  local folder dir
  folder="$(aeolus_folder)" || return 1
  dir="$(aeolus_ships_dir)" || return 1
  printf '%s/%s.questions' "$dir" "$(aeolus_key "$folder")"
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
  local identity="$1" action="$2" outcome="$3" next="${4:-}" text file record
  text="$(aeolus_identity_read "$identity")" || return 0
  file="$(aeolus_log_file 2>/dev/null)" || return 0
  mkdir -p "$(dirname "$file")" 2>/dev/null || return 0
  aeolus_log_rotate "$file"
  record="{\"time\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
  record="${record},\"shipId\":\"$(aeolus_json_escape "$(aeolus_identity_field "$text" shipId)")\""
  record="${record},\"shipName\":\"$(aeolus_json_escape "$(aeolus_identity_field "$text" shipName)")\""
  record="${record},\"action\":\"${action}\",\"outcome\":\"$(aeolus_json_escape "$outcome")\""
  [ -z "$next" ] || record="${record},\"next\":\"$(aeolus_json_escape "$next")\""
  # One write of a short line to a file opened for appending: concurrent hooks and watchers never interleave.
  printf '%s}\n' "$record" >> "$file" 2>/dev/null || true
}

# The text of an identity file, read once, so a script works from one view of
# it. Fails when the folder crews no ship, also when the file went since a
# script looked for it.
aeolus_identity_read() {
  cat "$1" 2>/dev/null
}

# One field of an identity's text: fleetUrl, shipId, shipName, crewToken, socket, lease or folder.
aeolus_identity_field() {
  local text="$1" field="$2"
  printf '%s\n' "$text" | sed -n "s/^${field}=//p" | head -n 1
}

# The sentence a start context gives a folder's read-only checkouts (#1182):
# each by its repository and where it is, and how to refresh them. Nothing
# when the identity names none. <identity text> <the refresh as the session runs it>
aeolus_checkouts_context() {
  local text="$1" refresh="$2" named
  named="$(printf '%s\n' "$text" | sed -n 's/^checkout=\([^=]*\)=\(.*\)$/\1 at \2/p' | awk 'NR > 1 { printf ", " } { printf "%s", $0 }')"
  [ -n "$named" ] || return 0
  printf 'Read-only checkouts beside this folder: %s. Read them; never change, commit or push in them. To bring them to the latest main, run %s: it answers the revision each now holds, or why it could not.' "$named" "$refresh"
}

# One field of an identity file as it is now, or nothing once it is gone.
aeolus_identity_get() {
  aeolus_identity_field "$(aeolus_identity_read "$1")" "$2"
}

# The crew token the identity file holds now, or nothing once it is gone: the
# folder may have been crewed again since a script read it.
aeolus_identity_token() {
  aeolus_identity_get "$1" crewToken
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
  pid="$(head -n 1 "$pid_file" 2>/dev/null)" || return 1
  aeolus_process_is "$pid" aeolus-wait.sh
}

# Text as a JSON string's contents: backslashes, quotes, newlines, tabs and
# every other control character (U+0001 to U+001F) escaped. A shell string
# holds no U+0000. Character by character, as any awk does it.
aeolus_json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk '
    BEGIN { for (code = 1; code < 32; code++) escaped[sprintf("%c", code)] = sprintf("\\u%04x", code); escaped["\t"] = "\\t"; escaped["\r"] = "\\r" }
    NR > 1 { printf "\\n" }
    {
      for (at = 1; at <= length($0); at++) {
        character = substr($0, at, 1)
        printf "%s", ((character in escaped) ? escaped[character] : character)
      }
    }'
}

# The value of a key of a JSON object's top level, as its JSON text: a key of
# the same name in a nested object or array is another field (#905). With
# `first`, the first element of the array it holds. Byte by byte in the C
# locale, as any awk does it. <json> <key> [first]
aeolus_json_value() {
  printf '%s' "$1" | tr -d '\n' | LC_ALL=C awk -v key="$2" -v is_first="${3:+1}" '
    # The end of the string that opens at `from`: the index of its closing quote.
    function string_end(text, from,   at) {
      for (at = from + 1; at <= length(text); at++) {
        if (substr(text, at, 1) == "\\") { at++; continue }
        if (substr(text, at, 1) == "\"") return at
      }
      return length(text) + 1
    }
    # The end of the value that starts at `from`: the index of its last character.
    function value_end(text, from,   at, character, depth) {
      character = substr(text, from, 1)
      if (character == "\"") return string_end(text, from)
      if (character != "{" && character != "[") {
        for (at = from; at <= length(text) && substr(text, at, 1) !~ /[],} \t\r]/; at++) {}
        return at - 1
      }
      for (at = from; at <= length(text); at++) {
        character = substr(text, at, 1)
        if (character == "\"") at = string_end(text, at)
        else if (character == "{" || character == "[") depth++
        else if ((character == "}" || character == "]") && --depth == 0) return at
      }
      return length(text)
    }
    function skip_space(text, at) {
      while (substr(text, at, 1) ~ /[ \t\r]/) at++
      return at
    }
    {
      text = $0
      object = skip_space(text, 1)
      if (substr(text, object, 1) != "{") exit
      at = skip_space(text, object + 1)
      while (substr(text, at, 1) == "\"") {
        end = string_end(text, at)
        name = substr(text, at + 1, end - at - 1)
        colon = skip_space(text, end + 1)
        if (substr(text, colon, 1) != ":") exit
        value = skip_space(text, colon + 1)
        if (name == key) {
          if (is_first) {
            if (substr(text, value, 1) != "[") exit
            value = skip_space(text, value + 1)
            if (substr(text, value, 1) == "]") exit
          }
          printf "%s", substr(text, value, value_end(text, value) - value + 1)
          exit
        }
        at = skip_space(text, value_end(text, value) + 1)
        if (substr(text, at, 1) != ",") exit
        at = skip_space(text, at + 1)
      }
    }'
}

# One string field of a hook's JSON payload or an answer, a key of its
# top-level object only, as aeolus_json_value reads it. Every escape undone: a
# \uXXXX (a surrogate pair too) as its UTF-8 bytes, but \u0000, which a shell
# string cannot hold, as nothing.
aeolus_json_string() {
  aeolus_json_value "$1" "$2" | LC_ALL=C awk '/^"/ { printf "%s", substr($0, 2, length($0) - 2) }' | LC_ALL=C awk '
    function hex(digits,   value, at) {
      for (at = 1; at <= 4; at++) value = value * 16 + index("0123456789abcdef", tolower(substr(digits, at, 1))) - 1
      return value
    }
    function utf8(code) {
      if (code < 128) return sprintf("%c", code)
      if (code < 2048) return sprintf("%c%c", 192 + int(code / 64), 128 + code % 64)
      if (code < 65536) return sprintf("%c%c%c", 224 + int(code / 4096), 128 + int(code / 64) % 64, 128 + code % 64)
      return sprintf("%c%c%c%c", 240 + int(code / 262144), 128 + int(code / 4096) % 64, 128 + int(code / 64) % 64, 128 + code % 64)
    }
    BEGIN { unescaped["b"] = "\b"; unescaped["f"] = "\f"; unescaped["n"] = "\n"; unescaped["r"] = "\r"; unescaped["t"] = "\t" }
    {
      for (at = 1; at <= length($0); at++) {
        character = substr($0, at, 1)
        if (character != "\\") { printf "%s", character; continue }
        letter = substr($0, ++at, 1)
        if (letter != "u") { printf "%s", ((letter in unescaped) ? unescaped[letter] : letter); continue }
        code = hex(substr($0, at + 1, 4)); at += 4
        if (code >= 55296 && code < 56320 && substr($0, at + 1, 2) == "\\u") {
          low = hex(substr($0, at + 3, 4))
          if (low >= 56320 && low < 57344) { code = 65536 + (code - 55296) * 1024 + low - 56320; at += 6 }
        }
        if (code > 0) printf "%s", utf8(code)
      }
    }'
}

# A hook's folder: Claude Code's project folder, else the payload's cwd (Codex
# has no project folder). The payload's cwd follows the session into a
# subfolder, so it would key another ship (#334); the project folder stays.
# A hook runs with the environment the harness inherited, never the session's
# own exports, so an AEOLUS_FOLDER there can be another session's (#881): the
# hook's own folder wins, and an AEOLUS_FOLDER that names another one is
# refused, so the hook acts as no ship (#884).
aeolus_hook_folder() {
  local own inherited="${AEOLUS_FOLDER:-}"
  own="${CLAUDE_PROJECT_DIR:-}"
  [ -n "$own" ] || own="$(aeolus_json_string "$1" cwd)"
  AEOLUS_FOLDER="${own:-$inherited}"
  export AEOLUS_FOLDER
  if [ -n "$own" ] && [ -n "$inherited" ] && [ "$(aeolus_physical_folder "$own")" != "$(aeolus_physical_folder "$inherited")" ]; then
    echo "aeolus: refused AEOLUS_FOLDER ${inherited}: this session's folder is ${own}" >&2
    return 1
  fi
}

# A folder as its physical path, so a link to it compares equal to it.
aeolus_physical_folder() {
  (cd "$1" 2>/dev/null && pwd -P) || printf '%s' "$1"
}

# The store of a crewed folder (#756): one entry per delivery the watcher
# received to hand to the session, so a restart of the watcher or the computer
# picks up where it was. Beside the turn marker, never the crew token. An entry
# is <deliveryId>.json (the delivery as the fleet's push receive answered it),
# <deliveryId>.state (received, handed or confirmed, with when),
# <deliveryId>.lease (the key of the lease it was received under, D7) and
# <deliveryId>.number (its last hand-over number, D4), <deliveryId>.reason
# (why it is not handled, for the fleet's notHandled, #847), with
# <deliveryId>.unreported while the fleet has not taken that hand-over yet; a
# ping in the turn has <deliveryId>.shown, and once pong answered it
# <deliveryId>.ponged; a long payload is in <deliveryId>.payload. Handled, an
# entry is removed.
aeolus_store_dir() {
  local folder dir store
  folder="$(aeolus_folder)" || return 1
  dir="$(aeolus_ships_dir)" || return 1
  store="$dir/$(aeolus_key "$folder").store"
  aeolus_store_version_guard "$store" || return 1
  printf '%s' "$store"
}

# This plugin's version, from its manifest; empty when unreadable.
aeolus_plugin_version() {
  local root manifest
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || return 0
  for manifest in "$root/.claude-plugin/plugin.json" "$root/.codex-plugin/plugin.json"; do
    [ -f "$manifest" ] || continue
    sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -n 1
    return 0
  done
}

# A store belongs to the newest plugin that wrote it (aeolus-fleet#1318): two
# plugins load in one session and share it, and an older one cannot confirm
# what a newer one handed. Fails, touching nothing in the store and logging
# once (kept in this plugin's own data folder), when the store was last written
# by a newer plugin; otherwise records this plugin's version in an existing
# store. <store folder>
aeolus_store_version_guard() {
  local store="$1" mine owner identity logged data
  mine="$(aeolus_plugin_version)"
  [ -n "$mine" ] && [ -d "$store" ] || return 0
  owner="$(cat "$store/.version" 2>/dev/null)"
  if [ -n "$owner" ] && [ "$owner" != "$mine" ] && [ "$(printf '%s\n%s\n' "$owner" "$mine" | sort -V | head -n 1)" = "$mine" ]; then
    data="$(aeolus_data 2>/dev/null)" && logged="$data/older-logged-$(basename "$store")"
    if [ -z "$logged" ] || [ "$(cat "$logged" 2>/dev/null)" != "$owner" ]; then
      [ -z "$logged" ] || printf '%s' "$owner" > "$logged" 2>/dev/null
      identity="$(aeolus_identity_file 2>/dev/null)" && aeolus_log "$identity" handover "left the store alone: a newer plugin owns it (${owner}, this one is ${mine})"
    fi
    return 1
  fi
  [ "$owner" = "$mine" ] || printf '%s' "$mine" > "$store/.version" 2>/dev/null
  return 0
}

# Whether a text is a delivery id, so it can name a file of the store.
aeolus_is_delivery_id() {
  case "$1" in
    dlv_[0-9a-z]*) [ "${#1}" -eq 30 ] && [ -z "${1//[0-9a-z_]/}" ] ;;
    *) return 1 ;;
  esac
}

# The key of the lease a crew token stands for, never the token itself: each
# crew of a folder holds one lease (#756, D7). <crew token>
aeolus_lease_key() {
  printf '%s' "$1" | aeolus_sha256 | cut -c1-16
}

# The key of the lease an identity's crew holds: its lease, kept by a folder that
# calls over its trierarch's socket, or that of its crew token. <identity text>
aeolus_identity_lease_key() {
  local lease token
  lease="$(aeolus_identity_field "$1" lease)"
  if [ -n "$lease" ]; then
    printf '%s' "$lease"
    return 0
  fi
  token="$(aeolus_identity_field "$1" crewToken)"
  [ -n "$token" ] || return 1
  aeolus_lease_key "$token"
}

# The key of the lease the folder's crew holds now; fails once it is gone.
aeolus_current_lease_key() {
  local identity
  identity="$(aeolus_identity_file)" || return 1
  aeolus_identity_lease_key "$(aeolus_identity_read "$identity")"
}

# Marks that the watcher's push receive made the folder's lease pushed (#756,
# D1): the lease key. From then on until the lease ends the hooks and the
# watcher report the turn and how each message ended.
aeolus_pushed_file() {
  local folder dir
  folder="$(aeolus_folder)" || return 1
  dir="$(aeolus_ships_dir)" || return 1
  printf '%s/%s.pushed' "$dir" "$(aeolus_key "$folder")"
}

# Whether this session reports its turn and its messages to the fleet: a
# session in Claude Code or Codex whose lease the watcher, the Codex wake
# bridge or the trierarch pushed. <identity text>
aeolus_reports_here() {
  [ "$(cat "$(aeolus_pushed_file)" 2>/dev/null)" = "$(aeolus_identity_lease_key "$1")" ]
}

# The turn as the fleet last took it: the turn marker's line it reported.
aeolus_turn_reported_file() {
  local file
  file="$(aeolus_turn_file)" || return 1
  printf '%s.reported' "$file"
}

# Reports the turn marker to the fleet, busy or idle with the time it was
# marked, unless the fleet took that line already: a report the fleet did not
# take is sent again with the next one, keeping its own time (3.15). One call,
# bounded as an acknowledgement is, so no hook waits long. <identity text>
aeolus_report_turn() {
  local marker state at
  aeolus_reports_here "$1" || return 0
  marker="$(head -n 1 "$(aeolus_turn_file)" 2>/dev/null)" || return 0
  [ -n "$marker" ] || return 0
  [ "$(cat "$(aeolus_turn_reported_file)" 2>/dev/null)" != "$marker" ] || return 0
  state="${marker%% *}"
  at="${marker#* }"
  if AEOLUS_CALL_MAX_SECONDS="${AEOLUS_CONFIRM_SECONDS:-3}" AEOLUS_BUSY_WAITS='' \
    "$(dirname "${BASH_SOURCE[0]}")/aeolus-fleet.sh" turn "{\"turn\":\"${state}\",\"at\":\"${at}\"}" >/dev/null 2>&1; then
    printf '%s\n' "$marker" > "$(aeolus_turn_reported_file)"
  fi
  return 0
}

# Drops the entries received under another lease than the folder's crew holds
# now (#756, D7): the folder was crewed again. An unconfirmed one comes back by
# push receive; a confirmed one stays acknowledged, handled unknown.
aeolus_store_drop_older_leases() {
  local dir lease file id identity
  dir="$(aeolus_store_dir)" || return 0
  [ -d "$dir" ] || return 0
  lease="$(aeolus_current_lease_key)" || return 0
  identity="$(aeolus_identity_file)" || return 0
  for file in "$dir"/*.state; do
    [ -f "$file" ] || continue
    id="${file##*/}"
    id="${id%.state}"
    if [ "$(cat "$dir/$id.lease" 2>/dev/null)" != "$lease" ]; then
      aeolus_store_drop "$id"
      aeolus_log "$identity" handover "dropped ${id}: it was received under an older lease"
    fi
  done
}

# Gets an entry ready to hand to the session (#756, D4): an entry the fleet
# took a hand-over of gets the next number, one whose hand-over the fleet has
# not taken yet keeps its number, so a lost answer counts no attempt. One whose
# ack went unanswered keeps its number too (#819): the fleet may hold it
# acknowledged, and answers only the same number so, refusing a higher one.
# Marks it handed, unless it is handed once more, which keeps it as it is.
# Prints the input of the fleet's handed. <deliveryId> [once-more]
aeolus_store_handing() {
  local id="$1" is_once_more="${2:-}" dir number
  dir="$(aeolus_store_dir)" || return 1
  number="$(cat "$dir/$id.number" 2>/dev/null)" || number=0
  if [ ! -e "$dir/$id.unreported" ] && [ ! -e "$dir/$id.acking" ]; then
    number=$((${number:-0} + 1))
    printf '%s\n' "$number" > "$dir/$id.number" || return 1
    : > "$dir/$id.unreported"
  fi
  [ -n "$is_once_more" ] || aeolus_store_mark "$id" handed
  printf '{"deliveryId":"%s","handOverNumber":%s%s}' "$id" "$number" "${is_once_more:+,\"isOnceMore\":true}"
}

# What the fleet answered a hand-over with: its state, or the code it refused
# it with. <identity file> <deliveryId> <state or code>. Returns 0 when the
# entry is handed (or the fleet holds it acknowledged already: the answer to
# a confirmation was lost, and the session has not seen it), 1 when it is
# dropped (undeliverable at its fifth attempt, or refused with any delivery
# code: no longer the session's to hand over), 2 when the fleet did not take
# the hand-over: hand it again later. A refused delivery is never handed
# again, so it blocks no other (#832).
aeolus_store_handed() {
  local identity="$1" id="$2" outcome="$3" dir
  dir="$(aeolus_store_dir)" || return 2
  case "$outcome" in
    handed|acknowledged)
      rm -f "$dir/$id.unreported"
      return 0
      ;;
    undeliverable)
      aeolus_store_drop "$id"
      aeolus_log "$identity" handover "dropped ${id}: undeliverable at its fifth attempt"
      return 1
      ;;
    DELIVERY_*)
      aeolus_store_drop "$id"
      aeolus_log "$identity" handover "dropped ${id}: the fleet refused the hand-over: ${outcome}"
      return 1
      ;;
  esac
  return 2
}

# Writes an entry's state, with the time in UTC: <deliveryId> <state>.
aeolus_store_mark() {
  local dir
  dir="$(aeolus_store_dir)" || return 1
  printf '%s %s\n' "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$dir/$1.state.tmp" && mv "$dir/$1.state.tmp" "$dir/$1.state"
}

# Keeps the delivery a push receive answered, as received: <the answer as
# JSON>. The store is keyed by the delivery id, so the same delivery received
# again is one entry, as it was. Prints its id; fails for an answer that holds
# none.
aeolus_store_put() {
  local delivery dir id number
  delivery="$(aeolus_json_value "$1" deliveries first)"
  id="$(aeolus_json_string "$delivery" deliveryId)"
  aeolus_is_delivery_id "$id" || return 1
  dir="$(aeolus_store_dir)" || return 1
  (umask 077 && mkdir -p "$dir") || return 1
  aeolus_store_version_guard "$dir" || return 1
  if [ ! -f "$dir/$id.state" ]; then
    printf '%s' "$delivery" > "$dir/$id.json" || return 1
    aeolus_current_lease_key > "$dir/$id.lease" || return 1
    aeolus_store_mark "$id" received || return 1
  fi
  # The fleet's last hand-over number counts on, when the store lost its own.
  number="$(printf '%s' "$delivery" | sed -n 's/.*"handOverNumber"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
  if [ -n "$number" ] && [ "$number" -gt "$(cat "$dir/$id.number" 2>/dev/null || echo 0)" ]; then
    printf '%s\n' "$number" > "$dir/$id.number"
  fi
  printf '%s' "$id"
}

# Whether the entry's delivery is forced (decision 0040). <deliveryId>
aeolus_store_is_forced() {
  local dir
  dir="$(aeolus_store_dir)" || return 1
  grep -Eq '"isForced"[[:space:]]*:[[:space:]]*true' "$dir/$1.json" 2>/dev/null
}

# An entry's state: received, handed or confirmed. Fails when there is none.
aeolus_store_state() {
  local dir
  dir="$(aeolus_store_dir)" || return 1
  cut -d ' ' -f 1 "$dir/$1.state" 2>/dev/null
}

# The oldest entry in one of the states given, without a ping already in the
# turn: delivery ids are time-ordered, so their order is the order of sending.
aeolus_store_first() {
  local dir file id state wanted
  aeolus_store_drop_older_leases
  dir="$(aeolus_store_dir)" || return 1
  for file in "$dir"/*.state; do
    [ -f "$file" ] || continue
    id="${file##*/}"
    id="${id%.state}"
    [ ! -e "$dir/$id.shown" ] || continue
    state="$(cut -d ' ' -f 1 "$file" 2>/dev/null)" || continue
    for wanted in "$@"; do
      if [ "$state" = "$wanted" ]; then
        printf '%s' "$id"
        return 0
      fi
    done
  done
  return 1
}

# Removes an entry: handled, or no longer the session's to take.
aeolus_store_drop() {
  local dir
  dir="$(aeolus_store_dir)" || return 0
  rm -f "$dir/$1.json" "$dir/$1.state" "$dir/$1.lease" "$dir/$1.number" "$dir/$1.unreported" "$dir/$1.acking" "$dir/$1.shown" "$dir/$1.ponged" "$dir/$1.payload" "$dir/$1.reason"
}

# Removes every entry, as on LEASE_ENDED.
aeolus_store_forget() {
  local dir
  dir="$(aeolus_store_dir)" || return 0
  rm -rf "$dir"
}

# Marks a ping of the store answered: pong succeeded for it.
aeolus_store_ponged() {
  local dir
  aeolus_is_delivery_id "$1" || return 0
  dir="$(aeolus_store_dir)" || return 0
  [ ! -f "$dir/$1.state" ] || : > "$dir/$1.ponged"
}

# The code a fleet call was refused with, as aeolus-fleet.sh says it, but not
# SERVICE_UNAVAILABLE: busy is no refusal of the call itself. Nothing when the
# fleet answered without a code, or not at all. <what aeolus-fleet.sh said>
aeolus_refusal_code() {
  local code
  code="$(printf '%s' "$1" | sed -n 's/^aeolus: the fleet refused [A-Za-z]*: \([A-Z_]*\):.*/\1/p')"
  [ "$code" = SERVICE_UNAVAILABLE ] || printf '%s' "$code"
}

# Reports how a message ended to the fleet: handled or notHandled. The fleet
# took it, or refused it as no longer the session's: the entry is dropped. Not
# taken (busy, or no answer): the entry keeps that state, to be reported again
# with the next call (3.15). Not handled goes with the reason the store keeps
# for it (#847). <identity file> <deliveryId> <handled|notHandled>
aeolus_report_end() {
  local identity="$1" id="$2" call="$3" output status reason=''
  [ "$call" != notHandled ] || reason="$(cat "$(aeolus_store_dir)/$id.reason" 2>/dev/null)"
  output="$(AEOLUS_CALL_MAX_SECONDS="${AEOLUS_CONFIRM_SECONDS:-3}" "$(dirname "${BASH_SOURCE[0]}")/aeolus-fleet.sh" "$call" "$id" ${reason:+"$reason"} 2>/dev/null)"
  status=$?
  case "$status" in
    0)
      aeolus_store_drop "$id"
      aeolus_log "$identity" handover "${call} ${id}: reported"
      ;;
    3) ;;
    *)
      if [ -n "$(aeolus_refusal_code "$output")" ]; then
        aeolus_store_drop "$id"
        aeolus_log "$identity" handover "dropped ${id}: the fleet refused ${call}: ${output}"
        return 0
      fi
      aeolus_log "$identity" handover "failed: ${call} ${id} not reported: ${output:-no answer}" 'reported again with the next call'
      ;;
  esac
  return 0
}

# Sends the fleet what it has not taken yet: the turn, and each message
# handled or not handled. <identity file>
aeolus_send_owed() {
  local identity="$1" text dir file id state
  text="$(aeolus_identity_read "$identity")" || return 0
  aeolus_reports_here "$text" || return 0
  aeolus_report_turn "$text"
  dir="$(aeolus_store_dir)" || return 0
  for file in "$dir"/*.state; do
    [ -f "$file" ] || continue
    id="${file##*/}"
    id="${id%.state}"
    state="$(aeolus_store_state "$id")"
    case "$state" in
      handled|notHandled) aeolus_report_end "$identity" "$id" "$state" ;;
    esac
  done
}

# A ping in the turn, at its end, on a pushed lease (3.17): handled when the
# fleet takes its handled, since only a pong acknowledged it; refused as not
# acknowledged, it was not answered and goes back to received, to be handed
# again. Not taken: handled when pong answered it here, else received again.
aeolus_end_ping() {
  local identity="$1" id="$2" dir output status
  dir="$(aeolus_store_dir)" || return 0
  output="$(AEOLUS_CALL_MAX_SECONDS="${AEOLUS_CONFIRM_SECONDS:-3}" "$(dirname "${BASH_SOURCE[0]}")/aeolus-fleet.sh" handled "$id" 2>/dev/null)"
  status=$?
  case "$status" in
    0)
      aeolus_store_drop "$id"
      aeolus_log "$identity" handover "handled ${id}: the ping was answered with pong"
      return 0
      ;;
    3) return 0 ;;
  esac
  case "$output" in
    *DELIVERY_NOT_ACKNOWLEDGED*) ;;
    *)
      if [ -n "$(aeolus_refusal_code "$output")" ]; then
        aeolus_store_drop "$id"
        aeolus_log "$identity" handover "dropped ${id}: the fleet refused handled: ${output}"
        return 0
      fi
      if [ -e "$dir/$id.ponged" ]; then
        rm -f "$dir/$id.shown"
        aeolus_store_mark "$id" handled
        aeolus_log "$identity" handover "failed: handled ${id} not reported: ${output:-no answer}" 'reported again with the next call'
        return 0
      fi
      ;;
  esac
  rm -f "$dir/$id.shown"
  aeolus_store_mark "$id" received
  aeolus_log "$identity" handover "received ${id} again: the ping was not answered with pong" 'handed again at the next idle'
}

# At the end of a turn: a confirmed message is handled, and so is a ping pong
# answered; a ping not answered goes back to received, to be handed again. On
# a pushed lease each is reported to the fleet.
aeolus_store_end_turn() {
  local identity="$1" dir file id is_reporting=0
  dir="$(aeolus_store_dir)" || return 0
  ! aeolus_reports_here "$(aeolus_identity_read "$identity")" || is_reporting=1
  for file in "$dir"/*.state; do
    [ -f "$file" ] || continue
    id="${file##*/}"
    id="${id%.state}"
    if [ "$(aeolus_store_state "$id")" = onceMore ] && [ -e "$dir/$id.shown" ]; then
      rm -f "$dir/$id.shown"
      aeolus_store_mark "$id" handled
      aeolus_log "$identity" handover "handled ${id}: the turn it was handed once more to ended"
      aeolus_report_end "$identity" "$id" handled
    elif [ -e "$dir/$id.shown" ] && [ "$is_reporting" = 1 ]; then
      aeolus_end_ping "$identity" "$id"
    elif [ -e "$dir/$id.shown" ]; then
      if [ -e "$dir/$id.ponged" ]; then
        aeolus_store_drop "$id"
        aeolus_log "$identity" handover "handled ${id}: the ping was answered with pong"
      else
        rm -f "$dir/$id.shown"
        aeolus_store_mark "$id" received
        aeolus_log "$identity" handover "received ${id} again: the ping was not answered with pong" 'handed again at the next idle'
      fi
    elif [ "$(aeolus_store_state "$id")" = confirmed ] && [ "$is_reporting" = 1 ]; then
      aeolus_store_mark "$id" handled
      aeolus_log "$identity" handover "handled ${id}: the turn that took it ended"
      aeolus_report_end "$identity" "$id" handled
    elif [ "$(aeolus_store_state "$id")" = confirmed ]; then
      aeolus_store_drop "$id"
      aeolus_log "$identity" handover "handled ${id}: the turn that took it ended"
    fi
  done
}

# The longest reason the fleet's notHandled takes (#847).
AEOLUS_REASON_MAX_CHARACTERS=200

# A reason as the fleet takes it: one line, cut to its longest, so a long or
# odd hook error never gets the report refused. <reason>
aeolus_one_line_reason() {
  local reason="${1//[$'\r\n']/ }"
  printf '%s' "${reason:0:$AEOLUS_REASON_MAX_CHARACTERS}"
}

# A turn that took messages died, without Stop (#756, D3): a confirmed message
# is to be handed once more, at the next prompt; one handed once more already,
# whose turn died too, is not handled, kept with the reason given, which
# says what died and how, for the operator (#847). Pings are left as they
# are: the next turn end takes them. <identity file> [<reason>]
aeolus_store_died_turn() {
  local identity="$1" reason="${2:-the turn it was handed once more to died too}" dir file id state
  dir="$(aeolus_store_dir)" || return 0
  for file in "$dir"/*.state; do
    [ -f "$file" ] || continue
    id="${file##*/}"
    id="${id%.state}"
    state="$(aeolus_store_state "$id")"
    if [ "$state" = confirmed ]; then
      aeolus_store_mark "$id" onceMore
      aeolus_log "$identity" handover "${id} to hand once more: the turn that took it died"
    elif [ "$state" = onceMore ] && [ -e "$dir/$id.shown" ]; then
      rm -f "$dir/$id.shown"
      printf '%s\n' "$(aeolus_one_line_reason "$reason")" > "$dir/$id.reason"
      aeolus_store_mark "$id" notHandled
      aeolus_log "$identity" handover "not handled ${id}: ${reason}"
    fi
  done
}

# A hook hands an entry over and reports it to the fleet (#756): as
# aeolus_store_handed returns, and 1 on LEASE_ENDED, when the store went with
# the ship. <identity file> <deliveryId> [once-more]
aeolus_report_handed() {
  local identity="$1" id="$2" output status outcome
  output="$(AEOLUS_CALL_MAX_SECONDS="${AEOLUS_CONFIRM_SECONDS:-3}" "$(dirname "${BASH_SOURCE[0]}")/aeolus-fleet.sh" handed "$(aeolus_store_handing "$id" "${3:-}")" 2>/dev/null)"
  status=$?
  case "$status" in
    0) outcome="$(aeolus_json_string "$output" state)" ;;
    3) return 1 ;;
    *) outcome="$(aeolus_refusal_code "$output")" ;;
  esac
  aeolus_store_handed "$identity" "$id" "$outcome"
}

# A person started the session again, after it died or was closed (#756, D6):
# what the store holds is marked for the first prompt. A received or handed
# message is reported handed with the next number, for the prompt to confirm;
# a confirmed one is kept to hand once more; one handed once more already is
# not handled, since its session died too, for the reason given.
# <identity file> <reason>
aeolus_store_session_started() {
  local identity="$1" dir file id state
  aeolus_store_drop_older_leases
  aeolus_store_died_turn "$identity" "$2"
  dir="$(aeolus_store_dir)" || return 0
  for file in "$dir"/*.state; do
    [ -f "$file" ] || continue
    id="${file##*/}"
    id="${id%.state}"
    [ ! -e "$dir/$id.shown" ] || continue
    state="$(aeolus_store_state "$id")"
    case "$state" in
      received|handed)
        aeolus_report_handed "$identity" "$id" && aeolus_log "$identity" handover "handed ${id} for the first prompt: the session started again"
        ;;
    esac
  done
  aeolus_send_owed "$identity"
}

# Puts the oldest message to hand once more into the turn (#756, D3), once the
# fleet took the hand-over with isOnceMore and the next number: it stays
# acknowledged, so no ack. A refusal drops it; not taken, it waits for the
# next prompt. <identity file> <shipName> <plugin root> <prefix>; prints the
# text, ending with an x; fails when nothing goes in.
aeolus_put_once_more() {
  local identity="$1" ship="$2" root="$3" prefix="$4" id dir
  id="$(aeolus_store_first onceMore)" || return 1
  dir="$(aeolus_store_dir)" || return 1
  aeolus_report_handed "$identity" "$id" once-more || return 1
  : > "$dir/$id.shown"
  aeolus_log "$identity" handover "handed ${id} once more: put into the turn"
  aeolus_turn_text "$id" "$ship" "$root" "${prefix}aeolus: handed before: the turn that took this message ended before it did, so it comes in once more."$'\n\n'
}

# The most a hook puts into a turn: Claude Code's cap on hook context (#756, D2).
AEOLUS_TURN_TEXT_MAX_BYTES=10000
# The first part of a longer payload that goes into the turn, beside its file.
AEOLUS_FIRST_PART_BYTES=8000

# How a session takes part in a meeting, for a delivery naming it (decision
# 0061): a contribution goes to the meeting, never with inReplyTo, and only
# with the mic. <meetingId> <contentType> <plugin root>.
aeolus_meeting_text() {
  local meeting="$1" content_type="$2" root="$3" selector input
  selector="{\"kind\":\"meeting\",\"meetingId\":\"${meeting}\"}"
  input="'{\"meetingId\":\"${meeting}\"}'"
  case "$content_type" in
    application/vnd.aeolus.meeting.mic+json)
      printf 'You hold the mic: contribute by sending to %s, never with inReplyTo, then release it with "%s/scripts/aeolus-fleet.sh" releaseMic %s.' "$selector" "$root" "$input"
      ;;
    application/vnd.aeolus.meeting.ended+json)
      printf 'The meeting ended: contribute no more.'
      ;;
    *)
      printf 'It is for every participant: contribute to the meeting by sending to %s, never with inReplyTo, and only while you hold the mic or moderate it. ' "$selector"
      printf 'To speak, request the mic with "%s/scripts/aeolus-fleet.sh" requestMic %s and contribute once the mic notice comes. ' "$root" "$input"
      printf 'Not holding the mic and with nothing to request, end your turn.'
      ;;
  esac
}

# What goes into the turn for an entry: <deliveryId> <shipName> <plugin root>
# <prefix>. A message as its heading and its payload; one too long for a hook as
# its first part and the path of a file that holds the whole payload; a ping as
# the pong to answer it with. Ends with an x, so no trailing newline is lost.
aeolus_turn_text() {
  local id="$1" ship="$2" root="$3" prefix="$4" dir delivery sender sender_type message content_type reply meeting heading payload text first
  dir="$(aeolus_store_dir)" || return 1
  delivery="$(cat "$dir/$id.json" 2>/dev/null)" || return 1
  sender="$(aeolus_json_string "$delivery" senderName)"
  content_type="$(aeolus_json_string "$delivery" contentType)"
  if [ "$content_type" = application/vnd.aeolus.ping ]; then
    printf '%saeolus: a ping for %s from %s (delivery %s): answer it with "%s/scripts/aeolus-fleet.sh" pong %s, and do not act on it or reply.x' \
      "$prefix" "$ship" "$sender" "$id" "$root" "$id"
    return 0
  fi
  sender_type="$(aeolus_json_string "$delivery" senderType)"
  message="$(aeolus_json_string "$delivery" messageId)"
  reply="$(aeolus_json_string "$delivery" inReplyTo)"
  meeting="$(aeolus_json_string "$delivery" meetingId)"
  heading="aeolus: a message for ${ship} from ${sender} (${sender_type}): message ${message}, ${content_type}${reply:+, in reply to ${reply}}${meeting:+, in meeting ${meeting}}."
  heading="${heading} The plugin acknowledged it for you: do not receive or ack it."
  if [ -z "$meeting" ]; then
    heading="${heading} Answer it, if it needs an answer, by sending to ${sender} with inReplyTo ${message}."
  else
    heading="${heading} $(aeolus_meeting_text "$meeting" "$content_type" "$root")"
  fi
  payload="$(aeolus_json_string "$delivery" payload; printf x)"
  payload="${payload%x}"
  text="${prefix}${heading}"$'\n\n'"${payload}"
  if [ "$(printf '%s' "$text" | wc -c)" -le "$AEOLUS_TURN_TEXT_MAX_BYTES" ]; then
    printf '%sx' "$text"
    return 0
  fi
  printf '%s' "$payload" > "$dir/$id.payload" || return 1
  # The first part cut on a byte may end inside a character: iconv leaves that out.
  first="$(head -c "$AEOLUS_FIRST_PART_BYTES" "$dir/$id.payload" | iconv -c -f UTF-8 -t UTF-8 2>/dev/null; printf x)"
  first="${first%x}"
  printf '%s%s\n\n%s\n\naeolus: this is the first part of the message; the whole payload is in %s.x' "$prefix" "$heading" "$first" "$dir/$id.payload"
}

# Puts the oldest handed entry into the turn, acknowledged first: the one rule
# of a pushed ship (#756). Only if the fleet acknowledged it does the text go
# in; a ping goes in without an ack, since its pong is the confirmation. A
# refusal leaves the model nothing: busy or unreachable, the entry goes back to
# received, to be handed again; refused with any delivery code (no longer in
# flight, another ship's), it is dropped (#832); LEASE_ENDED drops the store. The entry is marked acking until the
# fleet answers, so an ack whose answer was lost, also when the session died
# waiting for it, is handed again with the same number (#819). Each ack call
# is bounded by AEOLUS_CONFIRM_SECONDS, so its retries end inside a hook's time.
# <identity file> <shipName> <plugin root> <prefix>; prints the text, ending
# with an x; fails when nothing goes in.
aeolus_put_into_turn() {
  local identity="$1" ship="$2" root="$3" prefix="$4" id dir output status code
  id="$(aeolus_store_first handed)" || return 1
  dir="$(aeolus_store_dir)" || return 1
  if [ "$(aeolus_json_string "$(cat "$dir/$id.json" 2>/dev/null)" contentType)" = application/vnd.aeolus.ping ]; then
    : > "$dir/$id.shown"
    aeolus_log "$identity" handover "put ping ${id} into the turn, for its pong"
    aeolus_turn_text "$id" "$ship" "$root" "$prefix"
    return
  fi
  : > "$dir/$id.acking"
  output="$(AEOLUS_CALL_MAX_SECONDS="${AEOLUS_CONFIRM_SECONDS:-3}" "$(dirname "${BASH_SOURCE[0]}")/aeolus-fleet.sh" ack "$id" 2>/dev/null)"
  status=$?
  # Only an ack the fleet never answered may be stored without the plugin knowing.
  [ "$status" = 6 ] || rm -f "$dir/$id.acking"
  case "$status" in
    0)
      aeolus_store_mark "$id" confirmed
      aeolus_log "$identity" handover "confirmed ${id}: acknowledged, then put into the turn"
      aeolus_turn_text "$id" "$ship" "$root" "$prefix"
      return
      ;;
    3)
      aeolus_store_forget
      aeolus_log "$identity" handover "dropped ${id}: LEASE_ENDED"
      return 1
      ;;
  esac
  code="$(printf '%s' "$output" | sed -n 's/^aeolus: the fleet refused ack: \([A-Z_]*\):.*/\1/p')"
  case "$code" in
    DELIVERY_*)
      aeolus_store_drop "$id"
      aeolus_log "$identity" handover "dropped ${id}: the fleet refused the ack: ${code}"
      ;;
    *)
      aeolus_store_mark "$id" received
      aeolus_log "$identity" handover "failed: ${id} not confirmed: ${output:-no answer}" 'handed again at the next idle'
      ;;
  esac
  return 1
}
