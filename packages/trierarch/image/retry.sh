#!/usr/bin/env bash
# Runs a command again while it fails, a bounded number of times with a doubling
# pause, so a short outage of a package server does not fail the image build.
#
# Usage: retry.sh <attempts> <first pause in seconds> <command> [argument...]
set -u

if [[ $# -lt 3 ]]; then
  echo "Usage: $0 <attempts> <first pause in seconds> <command> [argument...]" >&2
  exit 2
fi
attempts=$1
pause=$2
shift 2

attempt=1
while true; do
  "$@" && exit 0
  code=$?
  if ((attempt >= attempts)); then
    echo "retry: '$*' failed $attempts times, last exit $code" >&2
    exit "$code"
  fi
  echo "retry: '$*' failed with exit $code, attempt $attempt of $attempts; next in ${pause}s" >&2
  sleep "$pause"
  pause=$((pause * 2))
  attempt=$((attempt + 1))
done
