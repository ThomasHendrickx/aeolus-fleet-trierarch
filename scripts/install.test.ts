import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const installScript = fileURLToPath(new URL('../install.sh', import.meta.url));
const REPOSITORY = 'ThomasHendrickx/aeolus-fleet-trierarch';
const BINARY_SAYS = 'the binary ran init';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aeolus-install-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, text: string, mode = 0o644): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, mode);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The binary of an asset name: a script that writes the words it was run with. */
function binaryText(): string {
  return `#!/bin/sh\necho "${BINARY_SAYS}: $*" > "${root}/ran"\n`;
}

/** A GitHub Release of the version: its API answer, its binaries and its SHA256SUMS. */
function release(version: string, options: { names?: string[]; sums?: (name: string, text: string) => string } = {}): void {
  const names = options.names ?? ['linux-amd64', 'linux-arm64', 'darwin-amd64', 'darwin-arm64'].map((each) => `aeolus-trierarch-${each}`);
  const sums = options.sums ?? ((name, text) => `${sha256(text)}  ${name}\n`);
  write(join(root, 'api', 'repos', REPOSITORY, 'releases', 'latest'), JSON.stringify({ tag_name: `v${version}` }));
  let all = '';
  for (const name of names) {
    const text = binaryText() + `# ${name} ${version}\n`;
    write(join(root, 'download', `v${version}`, name), text);
    all += sums(name, text);
  }
  write(join(root, 'download', `v${version}`, 'SHA256SUMS'), all);
}

/** Stand-ins for what the machine has: uname of a system and chip, and gh with the verdict on an attestation. */
function machine(system: string, chip: string, attestation: 'holds' | 'fails' | 'absent'): string {
  const bin = join(root, 'bin');
  write(join(bin, 'uname'), `#!/bin/sh\ncase "$1" in -s) echo ${system};; -m) echo ${chip};; esac\n`, 0o755);
  if (attestation !== 'absent') {
    write(
      join(bin, 'gh'),
      `#!/bin/sh\necho "$*" >> "${root}/gh"\n${attestation === 'holds' ? 'exit 0' : 'echo no attestation >&2; exit 1'}\n`,
      0o755,
    );
  }
  return bin;
}

function install(bin: string, args: string[] = [], env: Record<string, string> = {}) {
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const toolFolders = ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin'];
  return spawnSync('sh', [installScript, ...args], {
    encoding: 'utf8',
    env: {
      PATH: [bin, ...toolFolders].join(':'),
      HOME: home,
      AEOLUS_TRIERARCH_RELEASES_URL: `file://${join(root, 'api')}`,
      AEOLUS_TRIERARCH_DOWNLOAD_URL: `file://${join(root, 'download')}`,
      ...env,
    },
  });
}

const installed = (): string => join(root, 'home', '.local', 'bin', 'aeolus-trierarch');

describe('the install script', () => {
  it.each([
    ['Linux', 'x86_64', 'linux-amd64'],
    ['Linux', 'aarch64', 'linux-arm64'],
    ['Darwin', 'x86_64', 'darwin-amd64'],
    ['Darwin', 'arm64', 'darwin-arm64'],
  ])('installs the binary of %s on %s, checked against SHA256SUMS and its attestation, and runs init with the arguments', (system, chip, asset) => {
    release('1.2.3');
    const result = install(machine(system, chip, 'holds'), ['--fleet-url', 'https://fleet.example', '--secret', 's3']);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(installed(), 'utf8')).toContain(`# aeolus-trierarch-${asset}`);
    expect(statSync(installed()).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(root, 'ran'), 'utf8').trim()).toBe(`${BINARY_SAYS}: init --fleet-url https://fleet.example --secret s3`);
    expect(readFileSync(join(root, 'gh'), 'utf8')).toMatch(
      new RegExp(`attestation verify .*aeolus-trierarch-${asset} --repo ${REPOSITORY} --signer-workflow ${REPOSITORY}/.github/workflows/release.yml`),
    );
  });

  it('refuses a binary whose checksum fails, and installs and runs nothing', () => {
    release('1.2.3', { sums: (name) => `${sha256('another file')}  ${name}\n` });
    const result = install(machine('Linux', 'x86_64', 'holds'), ['--secret', 's3']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('checksum');
    expect(existsSync(installed())).toBe(false);
    expect(existsSync(join(root, 'ran'))).toBe(false);
  });

  it('refuses a binary SHA256SUMS does not name', () => {
    release('1.2.3', { sums: () => '' });
    const result = install(machine('Linux', 'x86_64', 'holds'));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('SHA256SUMS');
    expect(existsSync(installed())).toBe(false);
  });

  it('refuses a binary whose attestation fails', () => {
    release('1.2.3');
    const result = install(machine('Linux', 'x86_64', 'fails'));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('attestation');
    expect(existsSync(installed())).toBe(false);
    expect(existsSync(join(root, 'ran'))).toBe(false);
  });

  it('refuses without gh, which checks the attestation, and names the route by hand', () => {
    release('1.2.3');
    const result = install(machine('Linux', 'x86_64', 'absent'), [], { PATH: `${join(root, 'bin')}:/usr/bin:/bin` });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('gh');
    expect(existsSync(installed())).toBe(false);
  });

  it('refuses a system or chip the release has no binary for', () => {
    release('1.2.3');
    expect(install(machine('FreeBSD', 'x86_64', 'holds')).status).not.toBe(0);
    expect(install(machine('Linux', 'riscv64', 'holds')).status).not.toBe(0);
    expect(existsSync(installed())).toBe(false);
  });

  it('installs the version AEOLUS_TRIERARCH_VERSION names, in the folder AEOLUS_TRIERARCH_BIN_DIR names', () => {
    release('1.2.3');
    release('0.9.0');
    write(join(root, 'api', 'repos', REPOSITORY, 'releases', 'latest'), JSON.stringify({ tag_name: 'v1.2.3' }));
    const folder = join(root, 'elsewhere');
    const result = install(machine('Linux', 'x86_64', 'holds'), [], { AEOLUS_TRIERARCH_VERSION: '0.9.0', AEOLUS_TRIERARCH_BIN_DIR: folder });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(folder, 'aeolus-trierarch'), 'utf8')).toContain('# aeolus-trierarch-linux-amd64 0.9.0');
  });

  it('replaces the binary of an earlier install', () => {
    release('1.2.3');
    write(installed(), 'old binary', 0o755);
    const result = install(machine('Linux', 'aarch64', 'holds'));

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(installed(), 'utf8')).toContain('# aeolus-trierarch-linux-arm64');
  });

  it('leaves the earlier binary when the new one is refused', () => {
    release('1.2.3', { sums: (name) => `${sha256('another file')}  ${name}\n` });
    write(installed(), 'old binary', 0o755);
    install(machine('Linux', 'x86_64', 'holds'));

    expect(readFileSync(installed(), 'utf8')).toBe('old binary');
  });
});
