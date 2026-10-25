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

# The aeolus-fleet plugin of this image, into the home the container has: the
# image's own, or the ship's own the trierarch mounts over it (decision 0039).
# Its install is linked from the image, so a container runs its image's plugin
# whatever an earlier one left in the home; its data folder stays in the home.
# The settings that enable it are merged into the home's settings, keeping
# what the trierarch wrote there.
link_plugin() {
  local plugins="$HOME/.claude/plugins" settings="$HOME/.claude/settings.json" entry merged
  mkdir -p "$plugins"
  for entry in /opt/aeolus-session/plugins/*; do
    [[ ${entry##*/} != data ]] || continue
    rm -rf "${plugins:?}/${entry##*/}"
    ln -s "$entry" "$plugins/${entry##*/}"
  done
  merged=$(jq -s '.[0] * .[1]' <(cat "$settings" 2> /dev/null || echo '{}') /opt/aeolus-session/settings.json) || return 1
  printf '%s\n' "$merged" > "$settings.aeolus-session.tmp" && mv "$settings.aeolus-session.tmp" "$settings"
}

link_plugin || echo "aeolus-session-init: could not link the aeolus-fleet plugin into $HOME" >&2
run_health_checks &
exec "$@"
