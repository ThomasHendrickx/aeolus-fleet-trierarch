#!/usr/bin/env bash
# The session container's init, under tini: runs the health checks of the
# containers the session's own Podman starts, then runs the given command.
# Podman runs health checks from systemd timers, and the container has no
# systemd, so without this Testcontainers would wait forever for a healthy
# container. Waits on Podman's events, so an idle session spends nothing.
set -uo pipefail

# Checks one container at its interval while it runs. An interval of 0 means
# its checks are run by hand only, as with systemd.
check_health() {
  local id=$1 interval
  interval=$(podman inspect --format '{{json .Config.Healthcheck}}' "$id" 2> /dev/null \
    | jq -r 'if . == null or (.Interval // 0) == 0 then empty else .Interval / 1e9 end')
  [[ -n $interval ]] || return 0
  while [[ $(podman inspect --format '{{.State.Running}}' "$id" 2> /dev/null) == true ]]; do
    podman healthcheck run "$id" > /dev/null 2>&1
    sleep "$interval"
  done
}

run_health_checks() {
  podman events --filter event=start --format '{{.ID}}' 2> /dev/null | while read -r id; do
    check_health "$id" &
  done
}

run_health_checks &
exec "$@"
