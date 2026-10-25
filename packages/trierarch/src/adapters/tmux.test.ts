import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newId } from '../../test/support/in-memory.js';
import { runCommand } from './run-command.js';
import { createTmux } from './tmux.js';

// Against the real tmux, on a tmux server of the test's own, its socket in the
// test's own folder under /tmp: on macOS $TMPDIR is so long that the socket
// path passes the Unix socket limit of 104 bytes (#559).

let server: string;
let folder: string;

beforeEach(() => {
  server = `trierarch-test-${newId('ship').slice(-8)}`;
  folder = realpathSync(mkdtempSync(join('/tmp', 'trierarch-tmux-')));
  vi.stubEnv('TMUX_TMPDIR', folder);
});

afterEach(async () => {
  await runCommand('tmux', { args: ['-L', server, 'kill-server'] });
  rmSync(folder, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** A session as a trierarch before headless sessions started it for the ship. */
async function anOlderSession(name: string, command = 'sleep 30'): Promise<void> {
  const started = await runCommand('tmux', { args: ['-L', server, 'new-session', '-d', '-s', name, command] });
  expect(started.status, started.stderr).toBe(0);
}

describe('the sessions an older trierarch started in tmux (headless H4, H19)', () => {
  it('lists none while no tmux server runs', async () => {
    await expect(createTmux({ server }).list()).resolves.toEqual([]);
  });

  it('lists each by its ship, and only its own sessions', async () => {
    const shipId = newId('ship');
    await anOlderSession(`trierarch-${shipId}`);
    await anOlderSession('thomas');

    await expect(createTmux({ server }).list()).resolves.toEqual([{ shipId, status: 'running' }]);
  });

  it('stops one, leaving the others', async () => {
    const scout = newId('ship');
    const lookout = newId('ship');
    await anOlderSession(`trierarch-${scout}`);
    await anOlderSession(`trierarch-${lookout}`);

    await createTmux({ server }).stop(scout);

    await expect(createTmux({ server }).list()).resolves.toEqual([{ shipId: lookout, status: 'running' }]);
  });
});
