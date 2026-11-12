import { describe, expect, it } from 'vitest';

import type { ServiceStatus } from '../adapters/service.js';
import { aTrierarch, SHIPS_ROOT } from '../../test/support/in-memory.js';
import { uninstallTrierarch } from './uninstall.js';

class FakeService {
  isInstalled = true;
  uninstall(): Promise<void> {
    this.isInstalled = false;
    return Promise.resolve();
  }
  status(): Promise<ServiceStatus> {
    return Promise.resolve({ file: '/LaunchAgents/dev.aeolus-fleet.trierarch.plist', isInstalled: this.isInstalled, isRunning: this.isInstalled });
  }
}

describe('aeolus-trierarch uninstall', () => {
  it('removes the service, stops every session, lists the worktrees it leaves, and deletes nothing', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId);
    await trierarch.pass();
    const service = new FakeService();

    const report = await uninstallTrierarch({ service, uninstall: trierarch.uninstall, home: '/Users/thomas/.aeolus/trierarch' });

    expect(service.isInstalled).toBe(false);
    expect(trierarch.processes.sessions.size).toBe(0);
    expect(trierarch.workspace.folders.has(`${SHIPS_ROOT}/${shipId}/repositories`)).toBe(true);
    expect(report).toMatchObject({ service: '/LaunchAgents/dev.aeolus-fleet.trierarch.plist', worktrees: [`${SHIPS_ROOT}/${shipId}/repositories`] });
    expect(report.said.join('\n')).toContain(`${SHIPS_ROOT}/${shipId}/repositories`);
    expect(report.said.join('\n')).toContain('/Users/thomas/.aeolus/trierarch');
  });

  it('says when it leaves no worktree', async () => {
    const report = await uninstallTrierarch({ service: new FakeService(), uninstall: aTrierarch().uninstall, home: '/Users/thomas/.aeolus/trierarch' });

    expect(report.worktrees).toEqual([]);
    expect(report.said.join('\n')).toContain('It leaves no worktree.');
  });
});
