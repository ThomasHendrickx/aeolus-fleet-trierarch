#!/usr/bin/env bash
set -eu

base=$1
head=$2
if [[ "$base" =~ ^0+$ ]]; then
  printf 'true\n'
  exit 0
fi

status=0
git diff --quiet "$base" "$head" -- \
  go/ contract/ plugins/aeolus-fleet/ packages/trierarch/ \
  .github/actions/test-images/ .github/workflows/ci.yml \
  package.json package-lock.json vitest.config.ts tsconfig.json tsconfig.base.json \
  scripts/support/test-folders.global-setup.ts scripts/support/test-folders.ts \
  scripts/contract-go-paths.sh || status=$?
case "$status" in
  0) printf 'false\n' ;;
  1) printf 'true\n' ;;
  *) exit "$status" ;;
esac
