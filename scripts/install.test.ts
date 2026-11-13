import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

function writeExecutable(path: string, text: string): void {
  write(path, text);
  chmodSync(path, 0o755);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The binary of an asset name: a script that writes the words it was run with. */
function binaryText(): string {
  return `#!/bin/sh\necho "${BINARY_SAYS}: $*" > "${root}/ran"\n`;
}

/** A GitHub Release of the version: its API answer, its binaries and its SHA256SUMS. */
function release(
  version: string,
  options: {
    names?: string[];
    sums?: (file: { name: string; text: string }) => string;
  } = {},
): void {
  const names = options.names ?? ['linux-amd64', 'linux-arm64', 'darwin-amd64', 'darwin-arm64'].map((each) => `aeolus-trierarch-${each}`);
  const sums = options.sums ?? (({ name, text }) => `${sha256(text)}  ${name}\n`);
  write(join(root, 'api', 'repos', REPOSITORY, 'releases', 'latest'), JSON.stringify({ tag_name: `v${version}` }));
  let all = '';
  for (const name of names) {
    const text = binaryText() + `# ${name} ${version}\n`;
    write(join(root, 'download', `v${version}`, name), text);
    all += sums({ name, text });
  }
  write(join(root, 'download', `v${version}`, 'SHA256SUMS'), all);
}

/** What the script runs besides uname and gh, found on the machine running the test. */
const TOOLS = ['awk', 'chmod', 'cp', 'curl', 'cut', 'grep', 'head', 'mkdir', 'mktemp', 'mv', 'rm', 'sed', 'sha256sum', 'shasum'];

function whereIs(tool: string): string | undefined {
  const found = spawnSync('sh', ['-c', `command -v ${tool}`], {
    encoding: 'utf8',
  }).stdout.trim();
  return found === '' ? undefined : found;
}

/** Stand-ins for what the machine has: uname of a system and chip, and gh with the verdict on an attestation. */
function machine({ system, chip, attestation }: { system: string; chip: string; attestation: 'holds' | 'fails' | 'absent' }): string {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  // Only these tools are on the script's PATH, so a gh on the machine running the test is not.
  for (const tool of TOOLS) {
    const found = whereIs(tool);
    if (found !== undefined && !existsSync(join(bin, tool))) symlinkSync(found, join(bin, tool));
  }
  writeExecutable(join(bin, 'uname'), `#!/bin/sh\ncase "$1" in -s) echo ${system};; -m) echo ${chip};; esac\n`);
  if (attestation !== 'absent') {
    writeExecutable(
      join(bin, 'gh'),
      `#!/bin/sh\necho "$*" >> "${root}/gh"\n${attestation === 'holds' ? 'exit 0' : 'echo no attestation >&2; exit 1'}\n`,
    );
  }
  return bin;
}

function install(bin: string, options: { args?: string[]; env?: Record<string, string>; home?: string } = {}) {
  const { args = [], env = {}, home = join(root, 'home') } = options;
  mkdirSync(home, { recursive: true });
  return spawnSync('/bin/sh', [installScript, ...args], {
    encoding: 'utf8',
    env: {
      PATH: bin,
      HOME: home,
      SHELL: '/bin/bash',
      AEOLUS_TRIERARCH_RELEASES_URL: `file://${join(root, 'api')}`,
      AEOLUS_TRIERARCH_DOWNLOAD_URL: `file://${join(root, 'download')}`,
      ...env,
    },
  });
}

const installed = (): string => join(root, 'home', '.local', 'bin', 'aeolus-trierarch');

describe('the install script', () => {
  it.each([
    { system: 'Linux', chip: 'x86_64', asset: 'linux-amd64' },
    { system: 'Linux', chip: 'aarch64', asset: 'linux-arm64' },
    { system: 'Darwin', chip: 'x86_64', asset: 'darwin-amd64' },
    { system: 'Darwin', chip: 'arm64', asset: 'darwin-arm64' },
  ])(
    'installs the binary of $system on $chip, checked against SHA256SUMS and its attestation, and runs init with the arguments',
    ({ system, chip, asset }) => {
      release('1.2.3');
      const result = install(machine({ system, chip, attestation: 'holds' }), {
        args: ['--fleet-url', 'https://fleet.example', '--secret', 's3'],
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(installed(), 'utf8')).toContain(`# aeolus-trierarch-${asset}`);
      expect(statSync(installed()).mode & 0o111).not.toBe(0);
      expect(readFileSync(join(root, 'ran'), 'utf8').trim()).toBe(`${BINARY_SAYS}: init --fleet-url https://fleet.example --secret s3`);
      expect(readFileSync(join(root, 'gh'), 'utf8')).toMatch(
        new RegExp(
          `attestation verify .*aeolus-trierarch-${asset} --repo ${REPOSITORY} --signer-workflow ${REPOSITORY}/.github/workflows/release.yml`,
        ),
      );
    },
  );

  it('refuses a binary whose checksum fails, and installs and runs nothing', () => {
    release('1.2.3', {
      sums: ({ name }) => `${sha256('another file')}  ${name}\n`,
    });
    const result = install(machine({ system: 'Linux', chip: 'x86_64', attestation: 'holds' }), {
      args: ['--secret', 's3'],
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('checksum');
    expect(existsSync(installed())).toBe(false);
    expect(existsSync(join(root, 'ran'))).toBe(false);
  });

  it('refuses a binary SHA256SUMS does not name', () => {
    release('1.2.3', { sums: () => '' });
    const result = install(machine({ system: 'Linux', chip: 'x86_64', attestation: 'holds' }));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('SHA256SUMS');
    expect(existsSync(installed())).toBe(false);
  });

  it('refuses a binary whose attestation fails', () => {
    release('1.2.3');
    const result = install(machine({ system: 'Linux', chip: 'x86_64', attestation: 'fails' }));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('attestation');
    expect(existsSync(installed())).toBe(false);
    expect(existsSync(join(root, 'ran'))).toBe(false);
  });

  it('without gh installs after the checksum alone, says so and shows the command to verify the attestation by hand', () => {
    release('1.2.3');
    const result = install(machine({ system: 'Linux', chip: 'x86_64', attestation: 'absent' }), {
      args: ['--secret', 's3'],
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(installed(), 'utf8')).toContain('# aeolus-trierarch-linux-amd64');
    expect(readFileSync(join(root, 'ran'), 'utf8').trim()).toBe(`${BINARY_SAYS}: init --secret s3`);
    const said = result.stdout + result.stderr;
    expect(said).toContain('checksum only');
    expect(said).toContain(`gh attestation verify ${installed()} --repo ${REPOSITORY} --signer-workflow ${REPOSITORY}/.github/workflows/release.yml`);
  });

  it('without gh still refuses a binary whose checksum fails', () => {
    release('1.2.3', { sums: ({ name }) => `${sha256('another file')}  ${name}\n` });
    const result = install(machine({ system: 'Linux', chip: 'x86_64', attestation: 'absent' }));

    expect(result.status).not.toBe(0);
    expect(existsSync(installed())).toBe(false);
    expect(existsSync(join(root, 'ran'))).toBe(false);
  });

  it('refuses a system or chip the release has no binary for', () => {
    release('1.2.3');
    expect(install(machine({ system: 'FreeBSD', chip: 'x86_64', attestation: 'holds' })).status).not.toBe(0);
    expect(install(machine({ system: 'Linux', chip: 'riscv64', attestation: 'holds' })).status).not.toBe(0);
    expect(existsSync(installed())).toBe(false);
  });

  it('installs the version AEOLUS_TRIERARCH_VERSION names, in the folder AEOLUS_TRIERARCH_BIN_DIR names', () => {
    release('1.2.3');
    release('0.9.0');
    write(join(root, 'api', 'repos', REPOSITORY, 'releases', 'latest'), JSON.stringify({ tag_name: 'v1.2.3' }));
    const folder = join(root, 'elsewhere');
    const result = install(machine({ system: 'Linux', chip: 'x86_64', attestation: 'holds' }), {
      env: {
        AEOLUS_TRIERARCH_VERSION: '0.9.0',
        AEOLUS_TRIERARCH_BIN_DIR: folder,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(folder, 'aeolus-trierarch'), 'utf8')).toContain('# aeolus-trierarch-linux-amd64 0.9.0');
  });

  it('replaces the binary of an earlier install', () => {
    release('1.2.3');
    writeExecutable(installed(), 'old binary');
    const result = install(machine({ system: 'Linux', chip: 'aarch64', attestation: 'holds' }));

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(installed(), 'utf8')).toContain('# aeolus-trierarch-linux-arm64');
  });

  it('leaves the earlier binary when the new one is refused', () => {
    release('1.2.3', {
      sums: ({ name }) => `${sha256('another file')}  ${name}\n`,
    });
    writeExecutable(installed(), 'old binary');
    install(machine({ system: 'Linux', chip: 'x86_64', attestation: 'holds' }));

    expect(readFileSync(installed(), 'utf8')).toBe('old binary');
  });

  describe('the PATH block', () => {
    const MARK = '# >>> aeolus-trierarch >>>';
    const home = (file: string): string => join(root, 'home', file);
    const shellOf = (name: string): string | undefined => whereIs(name);

    function run(shell: string, extra: { env?: Record<string, string>; home?: string } = {}) {
      release('1.2.3');
      return install(machine({ system: 'Linux', chip: 'x86_64', attestation: 'holds' }), {
        env: { SHELL: shell, ...extra.env },
        home: extra.home,
      });
    }

    it('writes the block in the login files of a home path with spaces', () => {
      const spaced = join(root, 'my home');
      const result = run('/bin/bash', { home: spaced });

      expect(result.status, result.stderr).toBe(0);
      for (const file of ['.bash_profile', '.profile']) {
        expect(readFileSync(join(spaced, file), 'utf8').split(MARK)).toHaveLength(2);
      }
    });

    it('writes the block once in a login file with no final newline, also when run a second time', () => {
      write(home('.profile'), 'export EDITOR=vi');
      run('/bin/bash');
      const first = readFileSync(home('.profile'), 'utf8');
      run('/bin/bash');

      expect(first.startsWith('export EDITOR=vi\n')).toBe(true);
      expect(first.split(MARK)).toHaveLength(2);
      expect(readFileSync(home('.profile'), 'utf8')).toBe(first);
    });

    it.each([
      { shell: '/bin/zsh', own: '.zprofile', other: '.bash_profile' },
      { shell: '/bin/bash', own: '.bash_profile', other: '.zprofile' },
    ])('writes one marked block in $own and ~/.profile for $shell, and in no other login file', ({ shell, own, other }) => {
      const result = run(shell);

      expect(result.status, result.stderr).toBe(0);
      for (const file of [own, '.profile']) {
        const text = readFileSync(home(file), 'utf8');
        expect(text.split(MARK)).toHaveLength(2);
        expect(text).toContain('# <<< aeolus-trierarch <<<');
        expect(text).toContain('$HOME/.local/bin');
      }
      expect(existsSync(home(other))).toBe(false);
    });

    it('for another shell writes ~/.profile only', () => {
      const result = run('/usr/bin/fish');

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(home('.profile'), 'utf8')).toContain(MARK);
      expect(existsSync(home('.zprofile'))).toBe(false);
      expect(existsSync(home('.bash_profile'))).toBe(false);
    });

    it('keeps what a login file held and changes nothing when run a second time', () => {
      write(home('.bash_profile'), 'export EDITOR=vi\n');
      write(home('.profile'), '# mine\n');
      run('/bin/bash');
      const first = { bash: readFileSync(home('.bash_profile'), 'utf8'), profile: readFileSync(home('.profile'), 'utf8') };
      const second = run('/bin/bash');

      expect(second.status, second.stderr).toBe(0);
      expect(first.bash.startsWith('export EDITOR=vi\n')).toBe(true);
      expect(first.profile.startsWith('# mine\n')).toBe(true);
      expect(readFileSync(home('.bash_profile'), 'utf8')).toBe(first.bash);
      expect(readFileSync(home('.profile'), 'utf8')).toBe(first.profile);
    });

    it('writes no block when PATH already holds the folder', () => {
      const result = run('/bin/bash', { env: { PATH: `${join(root, 'bin')}:${join(root, 'home', '.local', 'bin')}` } });

      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(home('.bash_profile'))).toBe(false);
      expect(existsSync(home('.profile'))).toBe(false);
    });

    it('says the current shell needs a new terminal', () => {
      const result = run('/bin/bash');

      expect(result.stdout + result.stderr).toContain('open a new terminal');
    });

    it.each(['bash', 'zsh'])('lets a new %s login shell find aeolus-trierarch', (name) => {
      const shell = shellOf(name);
      if (shell === undefined) return;
      run(shell);
      const found = spawnSync(shell, ['-l', '-c', 'command -v aeolus-trierarch'], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', HOME: join(root, 'home') },
      });

      expect(found.stdout.trim()).toBe(installed());
    });
  });
});
