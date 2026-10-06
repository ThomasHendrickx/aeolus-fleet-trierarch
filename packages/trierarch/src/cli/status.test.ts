import { describe, expect, it } from 'vitest';

import { FleetRefusal } from '../adapters/rest-fleet.js';
import type { ServiceStatus } from '../adapters/service.js';
import { aTrierarch, aWant, CONFIGURATION, newId, WORKTREE_ROOT } from '../../test/support/in-memory.js';
import { describeStatus, inspectStatus, leaseFrom, type Lease } from './status.js';

const RUNNING: ServiceStatus = { file: '/LaunchAgents/dev.aeolus-fleet.trierarch.plist', isInstalled: true, isRunning: true, pid: 4242, since: '2026-10-06T07:00:00.000Z' };
const shipId = newId('ship');
const crew = { fleetUrl: 'https://fleet.example.com', shipId, crewToken: 'aeolus_ct_v1_trierarch' };

function inspect(trierarch = aTrierarch(), more: { service?: ServiceStatus; lease?: Lease } = {}) {
  return inspectStatus({
    configuration: CONFIGURATION,
    version: '0.18.0',
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
