import { beforeEach, describe, expect, it } from 'vitest';

import type { RunningFile } from '../adapters/files.js';
import type { CommandResult } from '../adapters/run-command.js';
import type { ServiceStatus } from '../adapters/service.js';
import { upgradeTrierarch, type Npm } from './upgrade.js';

const PACKAGE = '@aeolus-fleet/trierarch';

let installed: string;
let latest: string;
let lookups: number;
let installs: string[];
let failing: CommandResult | undefined;
let failingWrite: CommandResult | undefined;
let steps: string[];
let isServiceInstalled: boolean;
/** What running.json says on each read after the new process starts, the last one from then on. */
let saying: (RunningFile | undefined)[];
let reads: number;
let waits: number[];

beforeEach(() => {
  installed = '0.17.1';
  latest = '0.17.2';
  lookups = 0;
  installs = [];
  failing = undefined;
  failingWrite = undefined;
  steps = [];
  isServiceInstalled = true;
  saying = [{ pid: 2, version: '0.17.2' }];
  reads = 0;
  waits = [];
});

function running(): Promise<RunningFile | undefined> {
  reads += 1;
  return Promise.resolve(saying[Math.min(reads, saying.length) - 1]);
}

function sleep(ms: number): Promise<void> {
  waits.push(ms);
  return Promise.resolve();
}

const npm: Npm = {
  latest: () => {
    lookups += 1;
    return Promise.resolve(latest);
  },
  install: (spec) => {
    installs.push(spec);
    if (failing !== undefined) {
      return Promise.resolve(failing);
    }
    installed = spec.slice(spec.lastIndexOf('@') + 1);
    return Promise.resolve({ status: 0, stdout: '', stderr: '' });
  },
};

/** The installed version's own `install --no-load`: it writes the service's file as that version writes it. */
function writeInstalledServiceFile(): Promise<CommandResult> {
  if (failingWrite !== undefined) {
    return Promise.resolve(failingWrite);
  }
  steps.push(`write ${installed}`);
  return Promise.resolve({ status: 0, stdout: '', stderr: '' });
}

const service = {
  // The command that upgrades runs the code already in memory, the version it replaces.
  rewrite: () => {
    steps.push('rewrite 0.17.1');
    return Promise.resolve();
  },
  reload: () => {
    steps.push('reload');
    return Promise.resolve();
  },
  stop: () => {
    steps.push(`stop ${installed}`);
    return Promise.resolve();
  },
  start: () => {
    steps.push(`start ${installed}`);
    return Promise.resolve();
  },
  status: (): Promise<ServiceStatus> => Promise.resolve({ file: '/LaunchAgents/dev.aeolus-fleet.trierarch.plist', isInstalled: isServiceInstalled, isRunning: isServiceInstalled, ...(isServiceInstalled && { pid: 2 }) }),
};

function upgrade(version?: string) {
  return upgradeTrierarch({ ...(version !== undefined && { version }), installedVersion: () => installed, npm, writeInstalledServiceFile, service, running, sleep });
}

describe('aeolus-trierarch upgrade', () => {
  it('installs the latest version from npm, pinned to it, then stops the old process and starts the new one', async () => {
    const report = await upgrade();

    expect(installs).toEqual([`${PACKAGE}@0.17.2`]);
    expect(steps).toEqual(['write 0.17.2', 'reload', 'stop 0.17.2', 'start 0.17.2']);
    expect(report).toMatchObject({ from: '0.17.1', to: '0.17.2', isUpgraded: true });
    expect(report.said.join('\n')).toContain('Upgraded the trierarch from 0.17.1 to 0.17.2');
  });

  it('installs the version it is given, without asking npm for the latest', async () => {
    await upgrade('0.17.0');

    expect(installs).toEqual([`${PACKAGE}@0.17.0`]);
    expect(lookups).toBe(0);
  });

  it('rewrites the service\'s file before it stops the old process, so the stop already ends the trierarch only, as init writes it (#485)', async () => {
    await upgrade();

    expect(steps.slice(0, 3)).toEqual(['write 0.17.2', 'reload', 'stop 0.17.2']);
  });

  it('writes the service\'s file as the version it installs writes it, not as the version it replaces (#492)', async () => {
    await upgrade();

    expect(steps).not.toContain('rewrite 0.17.1');
    expect(steps[0]).toBe('write 0.17.2');
  });

  it('leaves the old process running when the installed version cannot write the service\'s file, saying what failed and what to do (#492)', async () => {
    failingWrite = { status: 1, stdout: '', stderr: 'EACCES: permission denied\n' };

    await expect(upgrade()).rejects.toThrow(
      'The trierarch 0.17.2 could not write the service\'s file: EACCES: permission denied\nThe service keeps running 0.17.1. Fix what it says, then run aeolus-trierarch install to write the file and restart the service.',
    );
    expect(steps).toEqual([]);
  });

  it('says it is already on a version and does nothing more', async () => {
    latest = '0.17.1';

    const report = await upgrade();

    expect(installs).toEqual([]);
    expect(steps).toEqual([]);
    expect(report).toMatchObject({ from: '0.17.1', to: '0.17.1', isUpgraded: false, said: ['The trierarch is already on 0.17.1.'] });
  });

  it('keeps the old version running when the install fails, saying what failed and what to do', async () => {
    failing = { status: 1, stdout: '', stderr: 'npm error code EACCES\nnpm error permission denied\n' };

    await expect(upgrade()).rejects.toThrow(
      `npm install --global ${PACKAGE}@0.17.2 failed: npm error code EACCES\nnpm error permission denied\nThe trierarch keeps running 0.17.1. Fix what npm says, then run aeolus-trierarch upgrade again.`,
    );
    expect(steps).toEqual([]);
  });

  it('refuses a version that is no MAJOR.MINOR.PATCH', async () => {
    await expect(upgrade('latest')).rejects.toThrow('latest is no version: give one such as 0.17.2');
    expect(installs).toEqual([]);
  });

  it('installs without touching a service that is not installed, and says how to install it', async () => {
    isServiceInstalled = false;

    const report = await upgrade();

    expect(installs).toEqual([`${PACKAGE}@0.17.2`]);
    expect(steps).toEqual([]);
    expect(report.said.join('\n')).toContain('The service is not installed: run aeolus-trierarch install');
  });

  it('waits for the new process to say its version before it reports, so the status that follows shows it running (#376)', async () => {
    saying = [{ pid: 1, version: '0.17.1' }, undefined, { pid: 2, version: '0.17.2' }];

    const report = await upgrade();

    expect(reads).toBe(3);
    expect(waits).toEqual([1000, 1000]);
    expect(report.said.join('\n')).toContain('The service runs 0.17.2 now.');
  });

  it('takes running.json as the new process\'s only once its pid is the one the service runs, as every start waits (#466)', async () => {
    saying = [{ pid: 1, version: '0.17.2' }, { pid: 2, version: '0.17.2' }];

    const report = await upgrade();

    expect(reads).toBe(2);
    expect(report.said.join('\n')).toContain('The service runs 0.17.2 now.');
  });

  it('stops waiting after 30 seconds when the new process has not said its version, and says so without telling to restart it (#376)', async () => {
    saying = [{ pid: 1, version: '0.17.1' }];

    const report = await upgrade();

    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBe(30_000);
    expect(report.said.join('\n')).toContain(
      'The service started 0.17.2, but the new process has not said its version after 30 seconds: aeolus-trierarch status shows the version it runs once it does.',
    );
    expect(report.said.join('\n')).not.toContain('The service runs 0.17.2 now.');
  });

  it('does not wait for a version when the service is not installed (#376)', async () => {
    isServiceInstalled = false;

    await upgrade();

    expect(reads).toBe(0);
  });
});
