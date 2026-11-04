import { beforeEach, describe, expect, it } from 'vitest';

import { TrierarchFileError, type RunningFile } from '../adapters/files.js';
import type { CommandResult } from '../adapters/run-command.js';
import type { ServiceStatus } from '../adapters/service.js';
import type { BinaryFile, BinaryRoute } from './upgrade-to-binary.js';
import { upgradeTrierarch, type Npm } from './upgrade.js';

// Today's trierarch moves to the Go trierarch by one upgrade (#142): the release's binary in ~/.local/bin, its own upgrade restarting the service on it.

const PATH = '/home/u/.local/bin/aeolus-trierarch';
const STAGED = '/home/u/.local/bin/.aeolus-trierarch-0.18.0';
const BINARY = Buffer.from('the Go trierarch 0.18.0');
const OK: CommandResult = { status: 0, stdout: '', stderr: '' };

/** What happened, in order: the file's steps, each run of a trierarch file, the service's steps and the npm installs. */
let steps: string[];
/** The release's binary of a version; none when the release carries none for this system and chip. */
let released: Buffer | undefined;
let releaseRefusal: string | undefined;
/** What the binary answers per command, the first word of its command line. */
let answers: Record<string, CommandResult>;
/** The service's process and what running.json says. */
let service: { pid: number; isInstalled: boolean };
let runningFile: RunningFile;
/** What the binary's upgrade does to the service: restart it on the binary, or nothing, as one that never restarts. */
let isRestartedByBinary: boolean;
/** Whether the service started on the binary says its version, as one that starts. */
let doesBinaryStart: boolean;

beforeEach(() => {
  steps = [];
  released = BINARY;
  releaseRefusal = undefined;
  service = { pid: 2, isInstalled: true };
  runningFile = { pid: 2, version: '0.17.1' };
  isRestartedByBinary = true;
  doesBinaryStart = true;
  answers = {
    '--version': { status: 0, stdout: '{"version":"0.18.0"}', stderr: '' },
    config: { status: 0, stdout: '{"path":"config.json"}', stderr: '' },
    upgrade: { status: 0, stdout: JSON.stringify({ from: '0.18.0', to: '0.18.0', isUpgraded: false, isPluginUpdated: true, said: ['The trierarch is already on 0.18.0.', 'Updated the aeolus-fleet plugin for Claude Code from 0.17.1 to 0.18.0.', 'The service ran 0.17.1, so it restarted on 0.18.0.'] }), stderr: '' },
  };
});

const file: BinaryFile = {
  path: PATH,
  stage: (binary) => {
    steps.push(`stage ${binary.toString()}`);
    return Promise.resolve(STAGED);
  },
  place: () => {
    steps.push('place');
    return Promise.resolve();
  },
  putBack: () => {
    steps.push('put back');
    return Promise.resolve();
  },
  settle: () => {
    steps.push('settle');
    return Promise.resolve();
  },
};

/** The service as the binary's upgrade leaves it: restarted on the binary, which says its version when it starts. */
function startOnBinary(): void {
  service = { ...service, pid: 3 };
  if (doesBinaryStart) {
    runningFile = { pid: 3, version: '0.18.0' };
  }
}

const route: BinaryRoute = {
  release: (version) => {
    steps.push(`release ${version}`);
    return releaseRefusal !== undefined ? Promise.reject(new TrierarchFileError(releaseRefusal)) : Promise.resolve(released);
  },
  file,
  run: (program, words) => {
    steps.push(`${program} ${words.join(' ')}`);
    if (words[0] === 'upgrade' && isRestartedByBinary) {
      startOnBinary();
    }
    return Promise.resolve(answers[words[0] ?? ''] ?? OK);
  },
};

const npm: Npm = {
  globalFolder: () => Promise.resolve({ path: '/usr/local/lib/node_modules', isWritable: true }),
  latest: () => Promise.resolve('0.18.0'),
  install: (spec) => {
    steps.push(`npm install ${spec}`);
    return Promise.resolve(OK);
  },
};

const serviceAt = {
  rewrite: () => {
    steps.push('rewrite 0.17.1');
    return Promise.resolve();
  },
  reload: () => {
    steps.push('reload');
    return Promise.resolve();
  },
  stop: () => {
    steps.push('stop');
    return Promise.resolve();
  },
  start: () => {
    steps.push('start');
    service = { ...service, pid: 4 };
    runningFile = { pid: 4, version: '0.17.1' };
    return Promise.resolve();
  },
  status: (): Promise<ServiceStatus> => Promise.resolve({ file: '/systemd/user/aeolus-trierarch.service', isInstalled: service.isInstalled, isRunning: service.isInstalled, ...(service.isInstalled && { pid: service.pid }) }),
};

function upgrade(version = '0.18.0') {
  return upgradeTrierarch({
    version,
    installedVersion: () => '0.17.1',
    npm,
    binaryRoute: route,
    writeInstalledServiceFile: () => Promise.resolve(OK),
    upgradeInstalledPlugin: () => Promise.resolve(OK),
    checkInstalledConfiguration: () => Promise.resolve(OK),
    service: serviceAt,
    running: () => Promise.resolve(runningFile),
    sleep: () => Promise.resolve(),
    plugin: { harnesses: ['claude-code'], update: () => Promise.resolve(), version: () => Promise.resolve('0.17.1'), trustCodexHooks: () => Promise.resolve([]) },
    removeRemoteControl: () => Promise.resolve([]),
    writeConfigurationSchema: () => Promise.resolve(),
  });
}

describe('aeolus-trierarch upgrade to a release that carries a binary for this system and chip (#142)', () => {
  it('puts the binary in ~/.local/bin once it says its version and accepts the configuration, then runs its own upgrade, never npm', async () => {
    await upgrade();

    expect(steps).toEqual(['release 0.18.0', 'stage the Go trierarch 0.18.0', `${STAGED} --version --json`, `${STAGED} config check --json`, 'place', `${PATH} upgrade 0.18.0 --json`, 'settle']);
  });

  it('reports the upgrade from the version it ran to the binary, with what the binary did', async () => {
    const report = await upgrade();

    expect(report).toMatchObject({ from: '0.17.1', to: '0.18.0', isUpgraded: true, isPluginUpdated: true });
    expect(report.said).toEqual(expect.arrayContaining(['Upgraded the trierarch from 0.17.1 to 0.18.0, the binary /home/u/.local/bin/aeolus-trierarch.', 'Updated the aeolus-fleet plugin for Claude Code from 0.17.1 to 0.18.0.', 'The service ran 0.17.1, so it restarted on 0.18.0.']));
    expect(report.said).not.toContain('The trierarch is already on 0.18.0.');
  });

  it('says ~/.local/bin must be on PATH and how to remove the npm package', async () => {
    const report = await upgrade();

    expect(report.said).toContain('The trierarch is the binary /home/u/.local/bin/aeolus-trierarch now: put /home/u/.local/bin on PATH if it is not, then remove the npm package with npm uninstall --global @aeolus-fleet/trierarch.');
  });

  it('takes npm as before when the release carries no binary for this system and chip', async () => {
    released = undefined;

    await upgrade();

    expect(steps).toContain('npm install @aeolus-fleet/trierarch@0.18.0');
    expect(steps.some((step) => step.startsWith('stage'))).toBe(false);
  });

  it('refuses with the reason when the binary does not check out, writing no file, and the trierarch keeps running', async () => {
    releaseRefusal = 'aeolus-trierarch-linux-amd64 of v0.18.0 is not the one SHA256SUMS names';

    await expect(upgrade()).rejects.toThrow('aeolus-trierarch-linux-amd64 of v0.18.0 is not the one SHA256SUMS names\nThe trierarch keeps running 0.17.1.');
    expect(steps).toEqual(['release 0.18.0']);
  });

  it('refuses when the binary says another version, putting nothing in place', async () => {
    answers['--version'] = { status: 0, stdout: '{"version":"0.17.9"}', stderr: '' };

    await expect(upgrade()).rejects.toThrow('The trierarch 0.18.0 does not run here: it says it runs 0.17.9\nThe trierarch keeps running 0.17.1.');
    expect(steps.slice(-1)).toEqual(['settle']);
    expect(steps).not.toContain('place');
  });

  it('refuses when the binary does not accept the configuration, the service and the plugin untouched', async () => {
    answers.config = { status: 1, stdout: '{"error":"remoteControl is no longer a key"}', stderr: '' };

    await expect(upgrade()).rejects.toThrow('The trierarch 0.18.0 does not accept the configuration: remoteControl is no longer a key\nIt stays on 0.17.1, running; the plugin and the service are untouched. Fix the configuration, then run aeolus-trierarch upgrade again.');
    expect(steps).not.toContain('place');
    expect(steps.some((step) => step.includes(' upgrade '))).toBe(false);
  });

  it('puts the old file back and restarts the service on itself when the binary did not start, saying so', async () => {
    doesBinaryStart = false;

    await expect(upgrade()).rejects.toThrow('The trierarch 0.18.0 did not start: it did not say its version (aeolus-trierarch logs says why).\nThe trierarch 0.17.1 runs again; the aeolus-fleet plugin stays on 0.18.0\'s: run aeolus-trierarch upgrade 0.17.1 to put it back too.');
    expect(steps.slice(steps.indexOf('put back'))).toEqual(['put back', 'rewrite 0.17.1', 'reload', 'stop', 'start', 'settle']);
    expect(runningFile).toEqual({ pid: 4, version: '0.17.1' });
  });

  it('puts the old file back when the binary did not restart the service at all', async () => {
    isRestartedByBinary = false;

    await expect(upgrade()).rejects.toThrow('The trierarch 0.18.0 did not start');
    expect(steps).toContain('put back');
  });

  it('places the binary without restarting anything when the service is not installed, and says how to run it', async () => {
    service = { pid: 2, isInstalled: false };
    answers.upgrade = { status: 0, stdout: JSON.stringify({ from: '0.18.0', to: '0.18.0', isUpgraded: false, isPluginUpdated: true, said: [] }), stderr: '' };

    const report = await upgrade();

    expect(steps).not.toContain(`${STAGED} config check --json`);
    expect(steps).not.toContain('put back');
    expect(report.said).toContain('The service is not installed: run /home/u/.local/bin/aeolus-trierarch init to run it.');
  });
});
