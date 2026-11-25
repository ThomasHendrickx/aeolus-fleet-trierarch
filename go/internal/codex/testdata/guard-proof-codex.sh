#!/bin/sh
# Stand in for Codex's app-server and the two exec turns of the guard diagnostic.
set -eu
umask 077

case "$1" in
  app-server)
    for arg do
      case "$arg" in
        hooks.PreToolUse=*)
          command_json=${arg#*command=}
          command_json=${command_json%,timeout=*}
          ;;
      esac
    done
    while IFS= read -r line; do
      case "$line" in
        *'"id":1,'*) printf '%s\n' '{"id":1,"result":{}}' ;;
        *'"id":2,'*) printf '{"id":2,"result":{"data":[{"hooks":[{"key":"guard","currentHash":"test-hash","source":"sessionFlags","eventName":"preToolUse","handlerType":"command","matcher":"*","command":%s,"timeoutSec":10,"enabled":true,"trustStatus":"trusted"}]}]}}\n' "$command_json" ;;
        *'"id":3,'*) printf '{"id":3,"result":{"data":[{"hooks":[{"key":"guard","currentHash":"test-hash","source":"sessionFlags","eventName":"preToolUse","handlerType":"command","matcher":"*","command":%s,"timeoutSec":10,"enabled":true,"trustStatus":"trusted"}]}]}}\n' "$command_json" ;;
      esac
    done
    ;;
  exec)
    mkdir -p "$CODEX_HOME/sessions"
    for prompt do :; done
    case "$prompt" in
      *'guard failure diagnostic'*)
        for cause in missing crash stall; do
          printf '{"type":"response_item","payload":{"type":"function_call_output","output":"Command blocked by PreToolUse hook: AEOLUS_GUARD_FAULT_%s Refused by the guard: guard failed"}}\n' "$cause"
        done > "$CODEX_HOME/sessions/rollout-faults.jsonl"
        printf '%s\n' '{"type":"thread.started","thread_id":"faults"}'
        ;;
      *)
        transcript="$CODEX_HOME/sessions/rollout-proof.jsonl"
        refusals="$HOME/.aeolus/trierarch/guard/$AEOLUS_SHIP/refusals.jsonl"
        while IFS='|' read -r tool rule summary; do
          printf '{"tool":"%s","rule":"%s","summary":"%s"}\n' "$tool" "$rule" "$summary" >> "$refusals"
          printf '{"type":"response_item","payload":{"type":"function_call_output","output":"Command blocked by PreToolUse hook: Refused by the guard: %s"}}\n' "$rule" >> "$transcript"
        done <<'REFUSALS'
Bash|commands.deny printf AEOLUS_GUARD_DENIED|printf AEOLUS_GUARD_DENIED
apply_patch|tools.deny file-write|
mcp__guard_probe__check|tools.deny mcp:guard_probe/check|
webrun|tools.deny web|
collaborationspawn_agent|tools.deny agent|
Bash|unresolvable: reads commands from stdin|bash --norc -i
Bash|protected: harness|codex --version
REFUSALS
        printf '%s\n' '{"type":"thread.started","thread_id":"proof"}' \
          '{"type":"item.completed","item":{"type":"command_execution","command":"printf AEOLUS_GUARD_ALLOWED","aggregated_output":"AEOLUS_GUARD_ALLOWED","exit_code":0}}' \
          '{"type":"turn.completed"}'
        ;;
    esac
    ;;
  *) exit 2 ;;
esac
