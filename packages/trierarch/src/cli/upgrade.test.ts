import { beforeEach, describe, expect, it } from 'vitest';

import type { CommandResult } from '../adapters/run-command.js';
import type { ServiceStatus } from '../adapters/service.js';
import { upgradeTrierarch, type Npm } from './upgrade.js';

const PACKAGE = '@aeolus-fleet/trierarch';

let installed: string;
let latest: string;
let lookups: number;
let installs: string[];
let failing: CommandResult | undefined;
let steps: string[];
let isServiceInstalled: boolean;

beforeEach(() => {
  installed = '0.17.1';
  latest = '0.17.2';
  lookups = 0;
  installs = [];
  failing = undefined;
  steps = [];
  isServiceInstalled = true;
});

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

const service = {
  stop: () => {
    steps.push(`stop ${installed}`);
    return Promise.resolve();
  },
  start: () => {
    steps.push(`start ${installed}`);
    return Promise.resolve();
  },
  status: (): Promise<ServiceStatus> => Promise.resolve({ file: '/LaunchAgents/dev.aeolus-fleet.trierarch.plist', isInstalled: isServiceInstalled, isRunning: isServiceInstalled }),
};

function upgrade(version?: string) {
  return upgradeTrierarch({ ...(version !== undefined && { version }), installedVersion: () => installed, npm, service });
}

describe('aeolus-trierarch upgrade', () => {
  it('installs the latest version from npm, pinned to it, then stops the old process and starts the new one', async () => {
    const report = await upgrade();

    expect(installs).toEqual([`${PACKAGE}@0.17.2`]);
    expect(steps).toEqual(['stop 0.17.2', 'start 0.17.2']);
    expect(report).toMatchObject({ from: '0.17.1', to: '0.17.2', isUpgraded: true });
    expect(report.said.join('\n')).toContain('Upgraded the trierarch from 0.17.1 to 0.17.2');
  });

  it('installs the version it is given, without asking npm for the latest', async () => {
    await upgrade('0.17.0');

    expect(installs).toEqual([`${PACKAGE}@0.17.0`]);
    expect(lookups).toBe(0);
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
});
