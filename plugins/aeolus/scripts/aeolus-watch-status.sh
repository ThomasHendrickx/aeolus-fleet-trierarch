#!/usr/bin/env bash
# Whether a watcher runs for this folder's ship. Exit 0 and "watching" when one
# does; exit 1 and "not watching" when none does.
set -uo pipefail
. "$(dirname "$0")/aeolus-lib.sh"

if aeolus_is_watching; then
  echo "aeolus: watching"
  exit 0
fi
echo "aeolus: not watching"
exit 1
