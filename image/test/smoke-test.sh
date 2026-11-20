#!/usr/bin/env bash
# Smoke test of the session image (decision 0039): the harness, the aeolus-fleet
# plugin of the image's version and a nested rootless Podman all work in a
# container started as the trierarch starts one, its input held on the host.
#
# Usage: smoke-test.sh <runtime binary> <image> <version>
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <runtime binary> <image> <version>" >&2
  exit 2
fi
RUNTIME=$1
IMAGE=$2
VERSION=$3

# The flags a nested rootless Podman needs: the session user is uid 1000 in the
# container, and SYS_ADMIN holds only inside the user namespace.
in_session() {
  "$RUNTIME" run --rm --pull=never \
    --userns=keep-id:uid=1000,gid=1000 \
    --device /dev/fuse --device /dev/net/tun \
    --cap-add SYS_ADMIN --security-opt unmask=ALL \
    "$IMAGE" "$@"
}

failures=0
check() {
  local name=$1
  shift
  if output=$("$@" 2>&1); then
    echo "ok: $name"
  else
    echo "FAILED: $name"
    echo "$output" | sed 's/^/  /'
    failures=$((failures + 1))
  fi
}

check 'claude runs' in_session claude --version

check 'GitHub CLI runs' in_session gh --version

# The hold runs the container attached, holding its stdin (headless H18): a
# line written there reaches the session through tini and the init.
takes_a_line() {
  echo smoke-line | "$RUNTIME" run --rm -i --pull=never \
    --userns=keep-id:uid=1000,gid=1000 \
    "$IMAGE" bash -c 'read -r line && [[ $line == smoke-line ]]'
}

check 'the session takes a line on its stdin' takes_a_line

PLUGIN_AT_VERSION="
  claude plugin list --json | node -e '
    const plugins = JSON.parse(require(\"node:fs\").readFileSync(0, \"utf8\"));
    const aeolus = plugins.find((plugin) => plugin.id === \"aeolus-fleet@aeolus-fleet\");
    if (aeolus?.version !== process.argv[1] || aeolus?.enabled !== true) {
      console.error(\"aeolus-fleet plugin:\", JSON.stringify(aeolus));
      process.exit(1);
    }
  ' '$VERSION'
"

check "the aeolus-fleet plugin is installed at $VERSION" in_session bash -c "$PLUGIN_AT_VERSION"

# The trierarch mounts a home of the ship's own over the image's: the image's
# plugin still reaches it, and what the plugin writes stays in that home.
SHIP_HOME=$(mktemp -d)
trap 'rm -rf "$SHIP_HOME"' EXIT
in_ship_home() {
  "$RUNTIME" run --rm --pull=never \
    --userns=keep-id:uid=1000,gid=1000 \
    --volume "$SHIP_HOME:/home/ubuntu" \
    "$IMAGE" "$@"
}

check "the aeolus-fleet plugin is installed at $VERSION in a home of the ship's own" in_ship_home bash -c "$PLUGIN_AT_VERSION"

# No aip of the image's own: a fleet adds aip as an MCP server of its own.
check 'the session has no aip CLI' in_session bash -c '! command -v aip'

# A link an earlier image made to its aip-runtime skill goes from the ship's
# home at the next start, and a skill of the session's own stays.
EARLIER_IMAGE_SKILLS='
  mkdir -p "$HOME/.claude/skills/own" \
    && ln -sfn /opt/aeolus-session/skills/aip-runtime "$HOME/.claude/skills/aip-runtime" \
    && aeolus-session-init true \
    && [[ ! -e $HOME/.claude/skills/aip-runtime && ! -L $HOME/.claude/skills/aip-runtime && -d $HOME/.claude/skills/own ]]
'

check "an earlier image's aip-runtime skill goes from a home of the ship's own" in_ship_home bash -c "$EARLIER_IMAGE_SKILLS"

# Nested containers from an image built in place, so the test pulls nothing:
# a shell, /usr/bin/true, /usr/bin/sleep and the libraries they load.
SMALL_IMAGE='
  set -euo pipefail
  root=$(mktemp -d)
  for file in /bin/sh /usr/bin/true /usr/bin/sleep $(ldd /bin/sh /usr/bin/true /usr/bin/sleep | grep -o "/[^ :]*" | sort -u); do
    mkdir -p "$root$(dirname "$file")"
    cp -L "$file" "$root$file"
  done
  tar -C "$root" -c . | podman import --quiet - localhost/smoke:latest > /dev/null
'

check 'a nested rootless podman runs a container' in_session bash -c "$SMALL_IMAGE"'
  podman run --rm localhost/smoke:latest /usr/bin/true
'

# Podman runs health checks from systemd timers, and the container has no
# systemd: without its init, Testcontainers waits forever for a healthy container.
check "a nested container's health check runs" in_session bash -c "$SMALL_IMAGE"'
  podman run --detach --name healthy --health-cmd /usr/bin/true --health-interval 1s \
    localhost/smoke:latest /usr/bin/sleep 60 > /dev/null
  for attempt in $(seq 20); do
    [[ $(podman inspect healthy --format "{{.State.Health.Status}}") == healthy ]] && exit 0
    sleep 0.5
  done
  podman inspect healthy --format "{{json .State.Health}}"
  exit 1
'

if [[ $failures -gt 0 ]]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo 'The session image passed its smoke test'
