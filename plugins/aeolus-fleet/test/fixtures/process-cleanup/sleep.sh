#!/bin/bash
sleep 120 &
child=$!
# Leave the temporary file empty briefly to exercise a reader scheduled before the write.
: > "$PROCESS_CLEANUP_CHILD.tmp"
sleep 0.2
printf '%s' "$child" > "$PROCESS_CLEANUP_CHILD.tmp"
mv "$PROCESS_CLEANUP_CHILD.tmp" "$PROCESS_CLEANUP_CHILD"
wait "$child"
