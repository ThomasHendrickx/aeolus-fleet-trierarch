#!/bin/bash
sleep 120 &
child=$!
printf '%s' "$child" > "$PROCESS_CLEANUP_CHILD"
wait "$child"
