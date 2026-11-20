import { describe, expect, it } from 'vitest';

import { processLeftovers, testRunLeftovers } from './check-test-run-leftovers.js';

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

describe('the test run process leftover check', () => {
  const processes = {
    startOf: (pid: number) => new Map([[101, '5000'], [102, '6000'], [104, '7000']]).get(pid),
    commandOf: (pid: number) => new Map([[101, 'node trierarch.ts service'], [102, 'node trierarch.ts proxy --folder /tmp/p']]).get(pid) ?? '',
  };

  it('reports each recorded process still running with the start time it was recorded with', () => {
    expect(processLeftovers('101 5000\n102 6000\n', processes)).toEqual([
      'process 101 (node trierarch.ts service) the test run started',
      'process 102 (node trierarch.ts proxy --folder /tmp/p) the test run started',
    ]);
  });

  it('reports no recorded process that ended, and none whose pid now names another process', () => {
    expect(processLeftovers('103 5000\n104 6500\n', processes)).toEqual([]);
  });

  it('reports a process recorded twice once', () => {
    expect(processLeftovers('101 5000\n101 5000\n', processes)).toHaveLength(1);
  });

  it('reports nothing for a run that recorded no process', () => {
    expect(processLeftovers('', processes)).toEqual([]);
  });
});
