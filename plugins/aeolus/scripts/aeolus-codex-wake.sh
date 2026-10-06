#!/usr/bin/env bash
# Local Codex wake bridge. It waits through the fleet's REST inbox without
# model tokens, then queues one message to the exact Desktop or CLI task.
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

usage() {
  echo "usage: aeolus-codex-wake.sh start|run <codex-thread-id>" >&2
  exit 2
}

mode="${1:-}"
thread_id="${2:-}"
[ "$mode" = start ] || [ "$mode" = run ] || usage
[ -n "$thread_id" ] || usage

identity="$(aeolus_identity_file)" || exit 2
if [ ! -f "$identity" ]; then
  echo "aeolus: this folder crews no ship; run \$aeolus-crew with the crew line first"
  exit 2
fi
# A session a trierarch crews: the trierarch wakes it, so no bridge of its own.
if aeolus_woken_by_trierarch "$identity"; then
  echo "aeolus: the trierarch wakes this session; no wake bridge armed"
  exit 0
fi
if ! command -v codex >/dev/null 2>&1; then
  echo "aeolus: codex is not on PATH; cannot arm automatic wake-up" >&2
  exit 7
fi

wake_pid_file="$(aeolus_wake_pid_file)"
wake_thread_file="$(aeolus_wake_thread_file)"
wake_log_file="$(aeolus_wake_log_file)"

if [ "$mode" = start ]; then
  if [ -f "$wake_pid_file" ]; then
    old_pid="$(head -n 1 "$wake_pid_file")"
    old_thread="$(head -n 1 "$wake_thread_file" 2>/dev/null || true)"
    if aeolus_process_is "$old_pid" aeolus-codex-wake.sh; then
      if [ "$old_thread" = "$thread_id" ]; then
        echo "aeolus: automatic wake-up is already armed for this Codex task"
        exit 0
      fi
      kill "$old_pid" 2>/dev/null || true
    fi
    rm -f "$wake_pid_file" "$wake_thread_file"
  fi
  if ! probe="$("$(dirname "$0")/aeolus-inbox.sh" 2>&1)"; then
    printf 'aeolus: cannot reach the fleet, so automatic wake-up is not armed: %s\n' "$probe" | tee -a "$wake_log_file" >&2
    exit 8
  fi
  AEOLUS_DATA="$(aeolus_data)" AEOLUS_FOLDER="$(aeolus_folder)" \
    nohup "$0" run "$thread_id" >> "$wake_log_file" 2>&1 </dev/null &
  bridge_pid=$!
  printf '%s\n' "$bridge_pid" > "$wake_pid_file"
  printf '%s\n' "$thread_id" > "$wake_thread_file"
  echo "aeolus: automatic wake-up armed for Codex task ${thread_id}"
  exit 0
fi

printf '%s\n' "$$" > "$wake_pid_file"
printf '%s\n' "$thread_id" > "$wake_thread_file"
wait_output="${wake_log_file}.wait.$$"
wait_pid=''
cleanup() {
  [ -z "$wait_pid" ] || kill "$wait_pid" 2>/dev/null || true
  if [ -f "$wake_pid_file" ] && [ "$(head -n 1 "$wake_pid_file")" = "$$" ]; then
    rm -f "$wake_pid_file" "$wake_thread_file"
  fi
  rm -f "$wait_output"
}
trap cleanup EXIT
trap 'exit 143' INT TERM

AEOLUS_MAX_SECONDS=2147483647 "$(dirname "$0")/aeolus-wait.sh" > "$wait_output" 2>&1 &
wait_pid=$!
wait "$wait_pid"
status=$?
wait_pid=''
answer="$(cat "$wait_output")"

case "$status" in
  0)
    ship_name="$(aeolus_identity_get "$identity" shipName)"
    waiting="$(printf '%s' "$answer" | sed -n 's/^aeolus: \([0-9][0-9]*\) deliveries\{0,1\} wait.*/\1/p')"
    [ -n "$waiting" ] || waiting='some'
    noun='deliveries'
    [ "$waiting" = 1 ] && noun='delivery'
    message="Aeolus has ${waiting} ${noun} waiting for ${ship_name}. Use \$aeolus-crew to receive and handle them, then re-arm automatic wake-up before ending the turn."
    codex queue --thread "$thread_id" --message "$message"
    ;;
  3|5)
    codex queue --thread "$thread_id" --message "$answer"
    ;;
  *)
    printf '%s' "$answer" >&2
    exit "$status"
    ;;
esac
