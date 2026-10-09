#!/usr/bin/env bash
# A ship reports an issue on the plugin's public repository. The session
# writes the report into a draft; this script strips it of what must not leave
# the machine, files it with gh when gh is signed in, and otherwise leaves the
# draft with a prefilled new-issue link. The draft itself stays local, whole.
#
#   aeolus-issue.sh draft          a new draft's path, in the plugin data folder
#   aeolus-issue.sh redact <file>  the file stripped for a public issue, on stdout
#   aeolus-issue.sh check <file>   exit 3, naming what is left, when the file is not fit for a public issue
#   aeolus-issue.sh file <draft>   strips, checks and files the draft: its first line is the title
#
# Stripped in two layers: what Aeolus knows (crew tokens, ship secrets, bearer
# values, the fleet host, the folder and home paths, the ship's name and every
# ship id), then personal and sensitive information by its shape (email
# addresses, phone numbers, IP addresses, URL credentials and query tokens,
# hosts other than github.com and aeolus-fleet.dev, API keys, private keys,
# JWTs, long high-entropy strings, card numbers and IBANs).
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

REPOSITORY='ThomasHendrickx/aeolus-fleet'
# GitHub refuses a URL much past 8 KB; the title and the cut notice need room too.
LINK_BODY_MAX=6000
SHIP_ID_PATTERN='shp_[0-9a-z]{26}'
# The gh that files the issue: gh on PATH, unless AEOLUS_GH names another, as
# the plugin's tests do so they never file a real issue.
GH="${AEOLUS_GH:-gh}"

identity="$(aeolus_identity_file)" || exit 2
fleet_url="$(aeolus_identity_get "$identity" fleetUrl 2>/dev/null)"
fleet_host="${fleet_url#*://}"
fleet_host="${fleet_host%%/*}"
ship_name="$(aeolus_identity_get "$identity" shipName 2>/dev/null)"
folder="$(aeolus_folder)"
raw_folder="${AEOLUS_FOLDER:-$folder}"

# The Aeolus layer: what the plugin itself knows must not leave the machine.
redact_aeolus() {
  local text
  text="$(sed -E \
    -e 's/([Bb]earer) +[^][ "'"'"']+/\1 [token]/g' \
    -e 's/aeolus_ct_v1_[A-Za-z0-9_-]+/[crew token]/g' \
    -e 's/aeolus_sk_v1_[A-Za-z0-9_-]+/[ship secret]/g' \
    -e "s/${SHIP_ID_PATTERN}/[ship id]/g")"
  # Literal text, longest first: a folder may lie under the home folder.
  text="${text//"$folder"/[folder]}"
  text="${text//"$raw_folder"/[folder]}"
  text="${text//"$HOME"/[home]}"
  [ -z "$fleet_host" ] || text="${text//"$fleet_host"/[fleet]}"
  [ -z "$ship_name" ] || text="${text//"$ship_name"/[ship]}"
  printf '%s\n' "$text"
}

# The sensitive-information layer: personal data and secrets of any kind, by
# their shapes. Each is replaced with a placeholder, and running it again
# changes nothing. Plain sed -E and POSIX awk, so it runs wherever Git Bash does.
filter_sensitive() {
  awk '
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/ { print "[private key]"; in_key = 1 }
    in_key { if ($0 ~ /-----END [A-Z ]*PRIVATE KEY-----/) in_key = 0; next }
    { print }
  ' | sed -E \
    -e 's/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/[jwt]/g' \
    -e 's/sk-[A-Za-z0-9_-]{16,}/[api key]/g' \
    -e 's/gh[pousr]_[A-Za-z0-9]{20,}/[api key]/g' \
    -e 's/github_pat_[A-Za-z0-9_]{20,}/[api key]/g' \
    -e 's/xox[abprs]-[A-Za-z0-9-]{10,}/[api key]/g' \
    -e 's/AKIA[0-9A-Z]{16}/[api key]/g' \
    -e 's!(://)[^]/@[ ]+@!\1[credentials]@!g' \
    -e 's!([?&](token|key|api_key|apikey|access_token|auth|sig|signature|secret|password|code|session)=)[^&# ]+!\1[token]!g' \
    -e 's!(://(\[credentials\]@)?)(([A-Za-z0-9-]+\.)*(github\.com|aeolus-fleet\.dev))!\1@@KEEP@@\3!g' \
    -e 's!(://(\[credentials\]@)?)[^]/@[ :?#"<>)]+!\1[host]!g' \
    -e 's!@@KEEP@@!!g' \
    -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/[email]/g' \
    -e 's/(^|[^A-Za-z0-9])[A-Z]{2}[0-9]{2}( ?[A-Z0-9]{4}){2,7}( ?[A-Z0-9]{1,4})?/\1[iban]/g' \
    -e 's/(^|[^0-9A-Za-z:])([0-9a-fA-F]{1,4}:)+:([0-9a-fA-F]{1,4}(:[0-9a-fA-F]{1,4})*)?/\1[ip]/g' \
    -e 's/(^|[^0-9A-Za-z:])([0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}/\1[ip]/g' \
    -e 's/(^|[^0-9.])([0-9]{1,3}\.){3}[0-9]{1,3}([^0-9]|$)/\1[ip]\3/g' |
  awk '
    # A card number: 13 to 19 digits, Luhn-valid, alone or in groups of four.
    function luhn(digits,   i, n, sum, other) {
      sum = 0; other = 0
      for (i = length(digits); i >= 1; i--) {
        n = substr(digits, i, 1) + 0
        if (other) { n = n * 2; if (n > 9) n = n - 9 }
        sum = sum + n; other = !other
      }
      return sum % 10 == 0
    }
    function cards(line,   out, run, before, rest, n, group, sep, result, i, j, digits, found) {
      out = ""
      while (match(line, /[0-9]+([ -][0-9]+)*/)) {
        run = substr(line, RSTART, RLENGTH); before = substr(line, 1, RSTART - 1); line = substr(line, RSTART + RLENGTH)
        n = 0; rest = run
        while (match(rest, /^[0-9]+/)) {
          n++; group[n] = substr(rest, 1, RLENGTH); rest = substr(rest, RLENGTH + 1)
          sep[n] = substr(rest, 1, 1); rest = substr(rest, 2)
        }
        result = ""; i = 1
        while (i <= n) {
          found = 0; digits = ""
          for (j = i; j <= n; j++) {
            if (j > i && length(group[j - 1]) != 4) break
            digits = digits group[j]
            if (length(digits) > 19) break
            if (length(digits) >= 13 && luhn(digits)) found = j
          }
          if (found) { result = result "[card number]" sep[found]; i = found + 1 }
          else { result = result group[i] sep[i]; i++ }
        }
        out = out before result
      }
      return out line
    }
    # A long high-entropy string: 32 or more characters mixing lower case, upper case and digits.
    function secrets(line,   out, word) {
      out = ""
      while (match(line, /[A-Za-z0-9+=_]+/)) {
        word = substr(line, RSTART, RLENGTH)
        if (RLENGTH >= 32 && word ~ /[a-z]/ && word ~ /[A-Z]/ && word ~ /[0-9]/) word = "[secret]"
        out = out substr(line, 1, RSTART - 1) word; line = substr(line, RSTART + RLENGTH)
      }
      return out line
    }
    { print secrets(cards($0)) }
  ' | sed -E \
    -e 's/\+[1-9][0-9]{0,3}([ .-]?\(?[0-9]{1,4}\)?){2,6}/[phone]/g' \
    -e 's/(^|[^0-9A-Za-z+])0[1-9][0-9]{0,3}[ \/.-]?[0-9]{2,4}([ .-][0-9]{2,4}){1,3}/\1[phone]/g'
}

redact() {
  redact_aeolus | filter_sensitive
}

# What a public issue must not carry and the file still does, one per line.
left_in() {
  local file="$1"
  grep -qi 'aeolus_ct_' "$file" && echo 'a crew token'
  grep -qi 'aeolus_sk_' "$file" && echo 'a ship secret'
  grep -qiE 'bearer +[^[ ]' "$file" && echo 'a bearer value'
  grep -qiE "$SHIP_ID_PATTERN" "$file" && echo 'a ship id'
  [ -n "$fleet_host" ] && grep -qiF "$fleet_host" "$file" && echo 'the fleet host'
  grep -qF "$folder" "$file" && echo 'the folder path'
  grep -qF "$HOME" "$file" && echo 'the home path'
  [ -n "$ship_name" ] && grep -qF "$ship_name" "$file" && echo 'the ship name'
  [ "$(filter_sensitive < "$file")" = "$(cat "$file")" ] || echo 'personal or sensitive information'
  return 0
}

check() {
  local left
  left="$(left_in "$1" | paste -sd ',' - | sed 's/,/, /g')"
  if [ -n "$left" ]; then
    echo "aeolus: the issue still carries ${left}; it is not filed" >&2
    return 3
  fi
}

# Text for a URL's query, cut once it reaches the most given: exit 1 when cut.
url_encode() {
  local LC_ALL=C text="$1" max="$2" out='' i c code hex
  for ((i = 0; i < ${#text}; i++)); do
    c="${text:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out="${out}${c}" ;;
      *)
        printf -v code '%d' "'$c"
        printf -v hex '%%%02X' "$((code & 255))"
        out="${out}${hex}"
        ;;
    esac
    if [ "${#out}" -ge "$max" ]; then
      printf '%s' "$out"
      return 1
    fi
  done
  printf '%s' "$out"
}

plugin_version() {
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$(dirname "$0")/../.claude-plugin/plugin.json" | head -n 1
}

case "${1:-}" in
  draft)
    dir="$(aeolus_data)/issues" || exit 2
    umask 077
    mkdir -p "$dir"
    echo "${dir}/$(date -u +%Y%m%dT%H%M%SZ)-$$.md"
    ;;
  redact)
    [ -f "${2:-}" ] || { echo "usage: aeolus-issue.sh redact <file>" >&2; exit 2; }
    redact < "$2"
    ;;
  check)
    [ -f "${2:-}" ] || { echo "usage: aeolus-issue.sh check <file>" >&2; exit 2; }
    check "$2"
    ;;
  file)
    draft="${2:-}"
    [ -f "$draft" ] || { echo "usage: aeolus-issue.sh file <draft>" >&2; exit 2; }
    public="${draft%.md}.public.md"
    umask 077
    {
      redact < "$draft"
      printf '\n---\n_Filed by an Aeolus ship (aeolus plugin %s, harness %s, OS %s)._\n' \
        "$(plugin_version)" "${AEOLUS_HARNESS:-claude-code}" "$(uname -s)"
    } > "$public"
    check "$public" || exit 3
    title="$(head -n 1 "$public" | sed 's/^#[[:space:]]*//')"
    body_file="${public%.md}.body.md"
    sed '1d' "$public" | sed '/./,$!d' > "$body_file"
    if command -v "$GH" >/dev/null 2>&1 && "$GH" auth status >/dev/null 2>&1; then
      if url="$("$GH" issue create --repo "$REPOSITORY" --title "$title" --body-file "$body_file")"; then
        echo "aeolus: issue filed: ${url}"
        echo "aeolus: tell argo: Issue filed: ${url}"
        exit 0
      fi
    fi
    body="$(url_encode "$(cat "$body_file")" "$LINK_BODY_MAX")" ||
      body="${body}$(url_encode $'\n\n(Cut to fit the link: paste the rest from the stripped draft.)' "$LINK_BODY_MAX")"
    link="https://github.com/${REPOSITORY}/issues/new?title=$(url_encode "$title" "$LINK_BODY_MAX")&body=${body}"
    echo "aeolus: issue draft: ${draft}"
    echo "aeolus: open: ${link}"
    # The draft stays local; argo learns where it is only through the same filter.
    echo "aeolus: tell argo: Issue draft: $(printf '%s' "$draft" | redact), open: ${link}"
    ;;
  *)
    echo "usage: aeolus-issue.sh draft|redact|check|file" >&2
    exit 2
    ;;
esac
