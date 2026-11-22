#!/usr/bin/env bash
# Asks the ship's owner a question as the ship protocol says (decisions 0038,
# 0045), or withdraws or replaces one, so a session writes no JSON by hand.
# whoami names the owner's ship (argo when argo owns the ship; argo by name
# for a ship with no owner). A withdrawal or replacement goes to the ship the
# question asked, as the folder kept it, even after the owner changed; the
# owner whoami names for a question the folder did not ask. Sends through
# aeolus-fleet.sh, which adds the crew token, and prints what it prints.
#
#   aeolus-ask.sh ask <question> [--model <model>]
#   aeolus-ask.sh withdraw <questionId> [--model <model>]
#   aeolus-ask.sh replace <questionId> <question> [--model <model>]
#
#   <question>: --title <title> [--context <context>]
#               --option <label> <detail> (once per option, numbered from 1 in order)
#               --pick <option number> <why>
#
# A question gets a new uuid; the script says it, to withdraw or replace the
# question by. The answer arrives as a reply to the question's message.
#
# Exit codes: 2 when the input is not a question, else those of aeolus-fleet.sh.
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

WITHDRAWAL_CONTENT_TYPE='application/vnd.aeolus.question-withdrawal+json'
REPLACEMENT_CONTENT_TYPE='application/vnd.aeolus.question-replacement+json'

usage() {
  [ -n "${1:-}" ] && echo "aeolus: $1" >&2
  echo "usage: aeolus-ask.sh ask [--selector <ship selector JSON>] --title <title> [--context <context>] --option <label> <detail>... --pick <option number> <why> [--model <model>]" >&2
  echo "       aeolus-ask.sh withdraw <questionId> [--model <model>]" >&2
  echo "       aeolus-ask.sh replace <questionId> --title <title> ... (as ask)" >&2
  exit 2
}

# A JSON string's contents: aeolus_json_escape, and tabs and carriage returns too.
json() {
  local escaped
  escaped="$(aeolus_json_escape "${1}x")"
  printf '%s' "${escaped%x}" | sed -e "s/$(printf '\t')/\\\\t/g" -e "s/$(printf '\r')/\\\\r/g"
}

new_uuid() {
  if [ -r /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
  else
    uuidgen
  fi | tr 'A-F' 'a-f'
}

is_uuid() {
  printf '%s' "$1" | grep -Eqx '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
}

# A selector for ask is a JSON object naming one ship. Parse its string
# members before storing it, using only the plugin's standard shell tools.
is_ship_selector() {
  printf '%s\n' "$1" | LC_ALL=C awk '
    function space() { while (substr(text, at, 1) ~ /^[ \t\r\n]$/) at++ }
    function string(    c, e, hex, n, i) {
      if (substr(text, at++, 1) != "\"") return 0
      value = ""
      while (at <= length(text)) {
        c = substr(text, at++, 1)
        if (c == "\"") return 1
        if (c ~ /[[:cntrl:]]/) return 0
        if (c == "\\") {
          e = substr(text, at++, 1)
          if (e == "u") {
            hex = substr(text, at, 4)
            if (length(hex) != 4 || hex !~ /^[0-9a-fA-F]+$/) return 0
            n = 0
            for (i = 1; i <= 4; i++) n = n * 16 + index("0123456789abcdef", tolower(substr(hex, i, 1))) - 1
            c = n > 0 && n < 128 ? sprintf("%c", n) : "?"
            at += 4
          } else if (e == "\"" || e == "\\" || e == "/") c = e
          else if (e ~ /^[bfnrt]$/) c = "?"
          else return 0
        }
        value = value c
      }
      return 0
    }
    { text = text (NR > 1 ? "\n" : "") $0 }
    END {
      at = 1; space()
      if (substr(text, at++, 1) != "{") exit 1
      space()
      while (substr(text, at, 1) != "}") {
        if (!string()) exit 1
        key = value; space()
        if (substr(text, at++, 1) != ":") exit 1
        space()
        if (!string()) exit 1
        fields[key] = value; space()
        c = substr(text, at++, 1)
        if (c == "}") { at--; break }
        if (c != ",") exit 1
        space()
        if (substr(text, at, 1) == "}") exit 1
      }
      at++; space()
      if (at <= length(text) || fields["kind"] != "ship") exit 1
      for (key in fields) if (key != "kind" && key != "name" && key != "shipId") exit 1
      if (("name" in fields) == ("shipId" in fields)) exit 1
      if ("name" in fields) {
        if (length(fields["name"]) > 48 || fields["name"] !~ /^[a-z0-9:-]+$/) exit 1
      } else {
        id = fields["shipId"]
        if (length(id) != 30 || id !~ /^shp_[0-7][0-9a-hjkmnp-tv-z]+$/) exit 1
      }
    }'
}

model=""
selector=""
selector_input=""
selector_set=0
title=""
context=""
options=()
pick=""
why=""

# Reads the question's flags and --model; sets question, as JSON, and id.
read_question() {
  local keys=0 label detail
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --selector) [ "$#" -ge 2 ] || usage "--selector takes a ship selector"; selector_input="$2"; selector_set=1; selector="$(printf '%s' "$2" | tr '\n\r' '  ')"; shift 2 ;;
      --title) [ "$#" -ge 2 ] || usage "--title takes the title"; title="$2"; shift 2 ;;
      --context-stdin) context="$(cat; printf x)"; context="${context%x}"; shift ;;
      --context) [ "$#" -ge 2 ] || usage "--context takes the context"; context="$2"; shift 2 ;;
      --option)
        [ "$#" -ge 3 ] || usage "--option takes a label and a detail"
        label="$2" detail="$3"
        [ -n "$label" ] || usage "every option has a label"
        keys=$((keys + 1))
        options+=("{\"key\":${keys},\"label\":\"$(json "$label")\",\"detail\":\"$(json "$detail")\"}")
        shift 3
        ;;
      --pick) [ "$#" -ge 3 ] || usage "--pick takes an option number and why"; pick="$2"; why="$3"; shift 3 ;;
      --model) [ "$#" -ge 2 ] || usage "--model takes the model"; model="$2"; shift 2 ;;
      *) usage "unknown argument: $1" ;;
    esac
  done
  [ -n "$title" ] || usage "a question has a title"
  [ "$keys" -gt 0 ] || usage "a question has at least one option"
  printf '%s' "$pick" | grep -Eqx '[1-9][0-9]*' && [ "$pick" -le "$keys" ] || usage "the pick names one of the options, by its number"
  [ -n "$why" ] || usage "the pick says why"
  id="$(new_uuid)"
  local joined
  joined="$(IFS=,; printf '%s' "${options[*]}")"
  question="{\"id\":\"${id}\",\"title\":\"$(json "$title")\",\"context\":\"$(json "$context")\",\"options\":[${joined}],\"pick\":{\"option\":${pick},\"why\":\"$(json "$why")\"}}"
}

read_model() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --model) [ "$#" -ge 2 ] || usage "--model takes the model"; model="$2"; shift 2 ;;
      *) usage "unknown argument: $1" ;;
    esac
  done
}

# Sets owner to the selector of the ship's owner, as whoami names it now;
# argo by name when the ship has none. Exits as aeolus-fleet.sh does when the
# fleet does not answer whoami, so nothing is sent to a guessed ship.
read_owner() {
  local output status ownerShipId
  output="$("$(dirname "$0")/aeolus-fleet.sh" whoami)"
  status=$?
  [ "$status" -eq 0 ] || { printf '%s\n' "$output"; exit "$status"; }
  ownerShipId="$(aeolus_json_string "$output" ownerShipId)"
  if [ -n "$ownerShipId" ]; then
    owner="{\"kind\":\"ship\",\"shipId\":\"$(json "$ownerShipId")\"}"
  else
    owner='{"kind":"ship","name":"argo"}'
  fi
}

# Sets asked to the selector of the ship the question <questionId> asked, as
# the folder kept it; the owner whoami names now for a question it did not ask.
read_asked() {
  local file line
  file="$(aeolus_questions_file)" && line="$(grep -m 1 "^$1 " "$file" 2>/dev/null)"
  if [ -n "${line:-}" ]; then
    asked="${line#* }"
  else
    read_owner
    asked="$owner"
  fi
}

# Keeps that question <questionId> asked the ship <selector>. Never fails its
# caller: the question is sent already.
keep_asked() {
  local file
  file="$(aeolus_questions_file)" || return 0
  printf '%s %s\n' "$1" "$2" >> "$file" 2>/dev/null || true
}

# Sends the ship <selector> <content type> <payload as JSON> <idempotency key>;
# prints what aeolus-fleet.sh prints, and sets sent to the message's id.
send_to() {
  local input output status
  input="{\"selector\":$1,\"contentType\":\"$2\",\"payload\":\"$(json "$3")\",\"idempotencyKey\":\"$4\"${model:+,\"model\":\"$(json "$model")\"}}"
  output="$(printf '%s' "$input" | "$(dirname "$0")/aeolus-fleet.sh" send -)"
  status=$?
  printf '%s\n' "$output"
  [ "$status" -eq 0 ] || exit "$status"
  sent="$(aeolus_json_string "$output" messageId)"
}

command="${1:-}"
[ "$#" -gt 0 ] && shift
case "$command" in
  ask)
    read_question "$@"
    if [ "$selector_set" -eq 1 ]; then is_ship_selector "$selector_input" || usage "--selector takes a ship selector"; fi
    if [ -z "$selector" ]; then read_owner; selector="$owner"; fi
    # Keep the recipient and expose the uuid before sending: a lost response
    # must still let the permission tool withdraw what may have reached it.
    keep_asked "$id" "$selector"
    echo "aeolus: question ${id}"
    input="${question%\}},\"selector\":${selector},\"idempotencyKey\":\"question-${id}\"${model:+,\"model\":\"$(json "$model")\"}}"
    output="$(printf '%s' "$input" | "$(dirname "$0")/aeolus-fleet.sh" ask -)"
    status=$?
    printf '%s\n' "$output"
    [ "$status" -eq 0 ] || exit "$status"
    sent="$(aeolus_json_string "$output" messageId)"
    echo "aeolus: asked question ${id} (message ${sent}); its answer arrives as a reply to that message. Withdraw or replace the question by its uuid ${id}."
    ;;
  withdraw)
    questionId="${1:-}"
    is_uuid "$questionId" || usage "withdraw takes the question's uuid"
    shift
    read_model "$@"
    read_asked "$questionId"
    send_to "$asked" "$WITHDRAWAL_CONTENT_TYPE" "{\"questionId\":\"${questionId}\"}" "question-withdrawal-${questionId}"
    echo "aeolus: withdrew question ${questionId} (message ${sent})"
    ;;
  replace)
    questionId="${1:-}"
    is_uuid "$questionId" || usage "replace takes the question's uuid"
    shift
    read_question "$@"
    [ -z "$selector" ] || usage "--selector applies only to ask"
    read_asked "$questionId"
    send_to "$asked" "$REPLACEMENT_CONTENT_TYPE" "{\"questionId\":\"${questionId}\",\"question\":${question}}" "question-replacement-${id}"
    keep_asked "$id" "$asked"
    echo "aeolus: replaced question ${questionId} with question ${id} (message ${sent}); its answer arrives as a reply to that message. Withdraw or replace the question by its uuid ${id}."
    ;;
  *)
    usage
    ;;
esac
