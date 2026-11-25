#!/bin/bash
sleep 120 &
child=$!
# Leave the file empty briefly to exercise a reader scheduled before the write.
: > "$PROCESS_CLEANUP_CHILD"
sleep 1
printf '%s' "$child" > "$PROCESS_CLEANUP_CHILD"
wait "$child"
