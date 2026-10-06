import { stripVTControlCharacters } from 'node:util';

import { describe, expect, it } from 'vitest';

import { FleetRefusal } from '../adapters/rest-fleet.js';
import type { RunningFile } from '../adapters/files.js';
import type { ServiceStatus } from '../adapters/service.js';
import { aTrierarch, aWant, CONFIGURATION, newId, WORKTREE_ROOT } from '../../test/support/in-memory.js';
import { describeStatus, inspectStatus, leaseFrom, type Lease } from './status.js';
import { createStyle } from './style.js';

const RUNNING: ServiceStatus = { file: '/LaunchAgents/dev.aeolus-fleet.trierarch.plist', isInstalled: true, isRunning: true, pid: 4242, since: '2026-10-06T07:00:00.000Z' };
const shipId = newId('ship');
const crew = { fleetUrl: 'https://fleet.example.com', shipId, crewToken: 'aeolus_ct_v1_trierarch' };

function inspect(trierarch = aTrierarch(), more: { service?: ServiceStatus; lease?: Lease; running?: RunningFile } = {}) {
  return inspectStatus({
    configuration: CONFIGURATION,
    version: '0.18.0',
    running: () => Promise.resolve('running' in more ? more.running : { pid: 4242, version: '0.18.0' }),
    crew,
    service: { status: () => Promise.resolve(more.service ?? RUNNING) },
    lease: () => Promise.resolve(more.lease ?? 'valid'),
    processes: trierarch.processes,
    state: trierarch.state,
  });
}

describe('aeolus-trierarch status', () => {
  it('says how the service runs, the fleet and its own lease, the caps in use, the entries by state, kept worktrees and orphans', async () => {
    const trierarch = aTrierarch();
    const scout = trierarch.fleet.commission('scout');
    await trierarch.command('want', aWant(scout));
    await trierarch.command('want', aWant(trierarch.fleet.commission('reviewer')));
    await trierarch.pass();
    trierarch.processes.exit(scout);
    await trierarch.pass();

    const report = await inspect(trierarch);

    expect(report).toEqual({
      version: '0.18.0',
      runningVersion: '0.18.0',
      service: RUNNING,
      fleet: { url: 'https://fleet.example.com', shipId, lease: 'valid' },
      caps: { ships: { used: 2, cap: 8 }, running: { used: 1, cap: 4 } },
      entries: { wanted: 0, crewing: 0, running: 1, restarting: 1, crashed: 0, releasing: 0 },
      kept: [],
      orphans: [],
    });
    expect(describeStatus(report)).toBe(
      [
        'Version: 0.18.0',
        'Service: running, pid 4242, since 2026-10-06T07:00:00.000Z',
        `Fleet: https://fleet.example.com, the lease of ${shipId} is valid`,
        'Caps: 2 of 8 ships on the list, 1 of 4 sessions running',
        'Entries: running 1, restarting 1',
        'Kept worktrees: none',
        'Orphans: none',
      ].join('\n'),
    );
  });

  it('colours how the service, the lease and the entries stand on a colour terminal, saying the same as in plain text', async () => {
    const report = await inspect(aTrierarch(), { lease: 'ended' });

    const coloured = describeStatus(report, createStyle({ isColour: true }));

    expect(coloured).not.toBe(describeStatus(report));
    expect(stripVTControlCharacters(coloured)).toBe(describeStatus(report));
  });

  it('lists kept worktrees and orphans', async () => {
    const trierarch = aTrierarch();
    const scout = trierarch.fleet.commission('scout');
    await trierarch.command('want', aWant(scout));
    await trierarch.pass();
    trierarch.workspace.change(`${WORKTREE_ROOT}/aeolus-fleet/scout`);
    await trierarch.command('release', { shipId: scout });
    await trierarch.pass();
    trierarch.workspace.folders.set(`${WORKTREE_ROOT}/aeolus-fleet/stray`, { hasChanges: false });
    await trierarch.pass();

    const text = describeStatus(await inspect(trierarch));

    expect(text).toContain(`Kept worktrees: ${WORKTREE_ROOT}/aeolus-fleet/scout (${scout})`);
    expect(text).toContain(`Orphans: ${WORKTREE_ROOT}/aeolus-fleet/stray`);
    expect(text).toContain('Entries: none');
  });

  it('says when the service is not installed, or installed and not running', async () => {
    expect(describeStatus(await inspect(aTrierarch(), { service: { file: '/plist', isInstalled: false, isRunning: false } }))).toContain(
      'Service: not installed (aeolus-trierarch install)',
    );
    expect(describeStatus(await inspect(aTrierarch(), { service: { file: '/plist', isInstalled: true, isRunning: false } }))).toContain(
      'Service: installed, not running (aeolus-trierarch start)',
    );
  });

  it('says the version the service runs, and to restart it, when it runs another than is installed', async () => {
    const report = await inspect(aTrierarch(), { running: { pid: 4242, version: '0.17.4' } });

    expect(report.runningVersion).toBe('0.17.4');
    expect(describeStatus(report)).toContain('Version: 0.18.0 installed, 0.17.4 running: restart the service to run the installed one (aeolus-trierarch restart)');
  });

  it('says the running version is unknown, and to restart, when the running service did not say which it runs', async () => {
    for (const running of [undefined, { pid: 1111, version: '0.18.0' }]) {
      const report = await inspect(aTrierarch(), { running });

      expect(report.runningVersion).toBeUndefined();
      expect(describeStatus(report)).toContain(
        'Version: 0.18.0 installed, the running service did not say its version, so it started before 0.18.0: restart it to run the installed one (aeolus-trierarch restart)',
      );
    }
  });

  it('gives only the installed version when the service does not run', async () => {
    const report = await inspect(aTrierarch(), { service: { file: '/plist', isInstalled: true, isRunning: false }, running: { pid: 4242, version: '0.17.4' } });

    expect(report.runningVersion).toBeUndefined();
    expect(describeStatus(report)).toContain('Version: 0.18.0\n');
  });

  it('says when its lease ended, or the fleet cannot be reached', async () => {
    expect(describeStatus(await inspect(aTrierarch(), { lease: 'ended' }))).toContain(`the lease of ${shipId} ended: its ship was released`);
    expect(describeStatus(await inspect(aTrierarch(), { lease: 'unreachable' }))).toContain('Fleet: https://fleet.example.com cannot be reached');
  });
});

describe('the lease, from whoami', () => {
  it('is valid when whoami answers, ended when the fleet refuses the crew token, and unreachable when the call fails', async () => {
    await expect(leaseFrom(() => Promise.resolve({}))()).resolves.toBe('valid');
    await expect(leaseFrom(() => Promise.reject(new FleetRefusal('LEASE_ENDED', 'released')))()).resolves.toBe('ended');
    await expect(leaseFrom(() => Promise.reject(new FleetRefusal('UNAUTHORIZED', 'no such token')))()).resolves.toBe('ended');
    await expect(leaseFrom(() => Promise.reject(new TypeError('fetch failed')))()).resolves.toBe('unreachable');
  });
});
