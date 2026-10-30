import { runCommand, type CommandResult } from '../../src/adapters/run-command.js';

/**
 * Whether the tests that run containers on the real rootless Podman can run on
 * this machine, and why not where they cannot, so a skip says why (#552).
 * GitHub's Ubuntu runners ship Podman; macOS has none.
 */
export type RootlessPodman = { readonly isUsable: true } | { readonly isUsable: false; readonly reason: string };

/** Asks `podman info` whether it runs rootless; a rootful or missing Podman is not used. */
export async function rootlessPodman(machine: { platform: NodeJS.Platform; info: () => Promise<CommandResult> }): Promise<RootlessPodman> {
  if (machine.platform !== 'linux') {
    return { isUsable: false, reason: `the container session runtime is tested on rootless Podman on Linux, not on ${machine.platform}` };
  }
  let answer: CommandResult;
  try {
    answer = await machine.info();
  } catch (error) {
    return { isUsable: false, reason: `podman does not run here: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (answer.status !== 0) {
    return { isUsable: false, reason: `podman info failed: ${answer.stderr.trim()}` };
  }
  return answer.stdout.trim() === 'true' ? { isUsable: true } : { isUsable: false, reason: 'podman runs rootful here, and the trierarch uses a rootless runtime only' };
}

/**
 * Builds a session image in place from this machine's own sh, sleep and nc,
 * and the libraries they load, so a test pulls nothing from a registry (#464):
 * the shell and sleep stand in for a harness, and nc, which connects to a Unix
 * socket, for the fleet client a session calls its ship's socket with.
 * Answers its name; the caller removes it.
 */
export async function buildTestSessionImage(name: string): Promise<string> {
  const script = `
    set -eu
    root=$(mktemp -d)
    trap 'rm -rf "$root"' EXIT
    programs="/bin/sh $(command -v sleep) $(command -v nc)"
    for file in $programs $(ldd $programs | grep -o '/[^ :]*' | sort -u); do
      mkdir -p "$root$(dirname "$file")"
      cp -L "$file" "$root$file"
    done
    mkdir -p "$root/tmp"
    chmod 1777 "$root/tmp"
    tar -C "$root" -c . | podman import --quiet - "$1" > /dev/null
  `;
  const built = await runCommand('sh', { args: ['-c', script, 'sh', name] });
  if (built.status !== 0) {
    throw new Error(`building the test session image failed: ${built.stderr.trim()}`);
  }
  return name;
}
