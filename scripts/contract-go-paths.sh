#!/usr/bin/env bash
set -eu

base=$1
head=$2
if [[ "$base" =~ ^0+$ ]]; then
  printf 'true\n'
  exit 0
fi

status=0
git diff --quiet "$base" "$head" -- go/ contract/ || status=$?
case "$status" in
  0) printf 'false\n' ;;
  1) printf 'true\n' ;;
  *) exit "$status" ;;
esac
