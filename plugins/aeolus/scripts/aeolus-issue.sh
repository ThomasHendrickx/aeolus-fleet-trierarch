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
# Stripped: crew tokens, ship secrets, bearer values, the fleet host, the
# folder and home paths, the ship's name and every ship id.
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

REPOSITORY='ThomasHendrickx/aeolus-fleet'
# GitHub refuses a URL much past 8 KB; the title and the cut notice need room too.
LINK_BODY_MAX=6000
SHIP_ID_PATTERN='shp_[0-9a-z]{26}'

identity="$(aeolus_identity_file)" || exit 2
fleet_url="$(aeolus_identity_get "$identity" fleetUrl 2>/dev/null)"
fleet_host="${fleet_url#*://}"
fleet_host="${fleet_host%%/*}"
ship_name="$(aeolus_identity_get "$identity" shipName 2>/dev/null)"
folder="$(aeolus_folder)"
raw_folder="${AEOLUS_FOLDER:-$folder}"

redact() {
  local text
  text="$(sed -E \
    -e 's/([Bb]earer) +[^][ "'"'"']+/\1 [token]/g' \
    -e 's/aeolus_ct_v1_[A-Za-z0-9_-]+/[crew token]/g' \
    -e 's/aeolus_sk_v1_[A-Za-z0-9_-]+/[ship secret]/g' \
    -e "s/${SHIP_ID_PATTERN}/[ship id]/g" "$1")"
  # Literal text, longest first: a folder may lie under the home folder.
  text="${text//"$folder"/[folder]}"
  text="${text//"$raw_folder"/[folder]}"
  text="${text//"$HOME"/[home]}"
  [ -z "$fleet_host" ] || text="${text//"$fleet_host"/[fleet]}"
  [ -z "$ship_name" ] || text="${text//"$ship_name"/[ship]}"
  printf '%s\n' "$text"
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
    redact "$2"
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
      redact "$draft"
      printf '\n---\n_Filed by an Aeolus ship (aeolus plugin %s, harness %s, OS %s)._\n' \
        "$(plugin_version)" "${AEOLUS_HARNESS:-claude-code}" "$(uname -s)"
    } > "$public"
    check "$public" || exit 3
    title="$(head -n 1 "$public" | sed 's/^#[[:space:]]*//')"
    body_file="${public%.md}.body.md"
    sed '1d' "$public" | sed '/./,$!d' > "$body_file"
    if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
      if url="$(gh issue create --repo "$REPOSITORY" --title "$title" --body-file "$body_file")"; then
        echo "aeolus: issue filed: ${url}"
        exit 0
      fi
    fi
    body="$(url_encode "$(cat "$body_file")" "$LINK_BODY_MAX")" ||
      body="${body}$(url_encode $'\n\n(Cut to fit the link: paste the rest from the stripped draft.)' "$LINK_BODY_MAX")"
    echo "aeolus: issue draft: ${draft}"
    echo "aeolus: open: https://github.com/${REPOSITORY}/issues/new?title=$(url_encode "$title" "$LINK_BODY_MAX")&body=${body}"
    ;;
  *)
    echo "usage: aeolus-issue.sh draft|redact|check|file" >&2
    exit 2
    ;;
esac
