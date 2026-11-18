import { describe, expect, it } from 'vitest';

import { testRunLeftovers } from './check-test-run-leftovers.js';

describe('the test run leftover check', () => {
  it('reports containers of both test labels and unused volumes', async () => {
    const leftovers = await testRunLeftovers({
      listContainers: ({ filters }) => Promise.resolve(filters.label[0] === 'aeolus-fleet.test-run'
        ? [{ Id: 'core', Image: 'postgres', State: 'exited', Labels: { 'aeolus-fleet.test-run': 'run' } }]
        : [{ Id: 'session', Image: 'session', State: 'running', Labels: { 'aeolus.trierarch.test-run': 'run' } }]),
      listVolumes: () => Promise.resolve({ Volumes: [{ Name: 'unused' }] }),
    });

    expect(leftovers).toEqual([
      'container core (postgres, exited) of test run run',
      'container session (session, running) of test run run',
      'volume unused, used by no container',
    ]);
  });

  it('reports nothing when both test labels and unused volumes are absent', async () => {
    await expect(testRunLeftovers({
      listContainers: () => Promise.resolve([]),
      listVolumes: () => Promise.resolve({ Volumes: [] }),
    })).resolves.toEqual([]);
  });
});
