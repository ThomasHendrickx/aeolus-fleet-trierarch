#!/usr/bin/env bash
set -eu

script="$(cd "$(dirname "$0")" && pwd)/contract-go-paths.sh"
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
cd "$test_dir"
git init -q
git config user.name 'CI test'
git config user.email 'ci-test@example.com'
mkdir -p go contract docs
printf 'base\n' > go/main.go
printf 'base\n' > contract/suite.ts
printf 'base\n' > docs/guide.md
git add .
git commit -qm base
base=$(git rev-parse HEAD)

check() {
  expected=$1
  actual=$(bash "$script" "$base" HEAD)
  if [ "$actual" != "$expected" ]; then
    printf 'expected %s, got %s\n' "$expected" "$actual" >&2
    exit 1
  fi
}

printf 'docs\n' >> docs/guide.md
git add . && git commit -qm docs
check false
printf 'go\n' >> go/main.go
git add . && git commit -qm go
check true
git reset -q --hard "$base"
rm contract/suite.ts
git add -A && git commit -qm contract-deleted
check true
printf 'contract path gate: docs skip; Go changes and deleted contract files run\n'
