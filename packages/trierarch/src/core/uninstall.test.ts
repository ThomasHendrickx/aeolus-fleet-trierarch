import { describe, expect, it } from 'vitest';

import { aTrierarch, aWant, WORKTREE_ROOT } from '../../test/support/in-memory.js';

describe('uninstalling the trierarch (docs/trierarch.md, row 10)', () => {
  it('stops every session first, lists the worktrees it leaves, and deletes nothing', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    await trierarch.command('want', aWant(shipId));
    await trierarch.pass();

    const { worktrees } = await trierarch.uninstall();

    expect(trierarch.processes.sessions.size).toBe(0);
    expect(worktrees).toEqual([`${WORKTREE_ROOT}/aeolus-fleet/scout`]);
    expect(trierarch.workspace.folders.has(`${WORKTREE_ROOT}/aeolus-fleet/scout`)).toBe(true);
  });
});
