import { expect, it } from 'vitest';

import type { SessionRuntime } from '../../src/core/ports.js';
import { newId } from './in-memory.js';

/**
 * What every session runtime does (decision 0039), so the reconciler, the
 * launch window and wakes behave the same whichever runs the sessions. Each
 * adapter's test calls it inside its own describe, with a fresh runtime and an
 * empty folder per test.
 */
export function sessionRuntimeContract(at: { runtime: () => SessionRuntime; folder: () => string }): void {
  const POLL = { timeout: 5000 };

  it('lists none before any starts', async () => {
    await expect(at.runtime().list()).resolves.toEqual([]);
  });

  it('starts the command in the folder, in a session for the ship, and lists it running', async () => {
    const runtime = at.runtime();
    const shipId = newId('ship');

    await runtime.start({ shipId, folder: at.folder(), command: ['sh', '-c', 'echo "in $(pwd)"; sleep 30'] });

    await expect(runtime.list()).resolves.toEqual([{ shipId, status: 'running' }]);
    await expect.poll(async () => runtime.screen(shipId), POLL).toContain(`in ${at.folder()}`);
  });

  it('starts the command with the environment given, such as its launch id (#490)', async () => {
    const runtime = at.runtime();
    const shipId = newId('ship');

    await runtime.start({ shipId, folder: at.folder(), command: ['sh', '-c', 'echo "launch $AEOLUS_LAUNCH"; sleep 30'], env: { AEOLUS_LAUNCH: 'launch-1' } });

    await expect.poll(async () => runtime.screen(shipId), POLL).toContain('launch launch-1');
  });

  it('keeps a session whose command ended, so the exit is seen', async () => {
    const runtime = at.runtime();
    const shipId = newId('ship');

    await runtime.start({ shipId, folder: at.folder(), command: ['sh', '-c', 'exit 3'] });

    await expect.poll(async () => runtime.list(), POLL).toEqual([{ shipId, status: 'exited' }]);
  });

  it('replaces an exited session when the ship starts again', async () => {
    const runtime = at.runtime();
    const shipId = newId('ship');
    await runtime.start({ shipId, folder: at.folder(), command: ['sh', '-c', 'exit 3'] });
    await expect.poll(async () => runtime.list(), POLL).toEqual([{ shipId, status: 'exited' }]);

    await runtime.start({ shipId, folder: at.folder(), command: ['sleep', '30'] });

    await expect(runtime.list()).resolves.toEqual([{ shipId, status: 'running' }]);
  });

  it('types text into the session and presses Enter', async () => {
    const runtime = at.runtime();
    const shipId = newId('ship');
    await runtime.start({ shipId, folder: at.folder(), command: ['sh', '-c', 'read line; echo "got $line"; sleep 30'] });

    await runtime.type({ shipId, text: '/aeolus:wake' });

    await expect.poll(async () => runtime.screen(shipId), POLL).toContain('got /aeolus:wake');
  });

  it('waits the settle time between the text and Enter when asked', async () => {
    const runtime = at.runtime();
    const shipId = newId('ship');
    const settleMs = 300;
    await runtime.start({ shipId, folder: at.folder(), command: ['sh', '-c', 'read line; echo "got $line"; sleep 30'] });
    const before = Date.now();

    await runtime.type({ shipId, text: '$aeolus-wake ', settleMs });

    expect(Date.now() - before).toBeGreaterThanOrEqual(settleMs);
    await expect.poll(async () => runtime.screen(shipId), POLL).toContain('got $aeolus-wake');
  });

  it("reads what the session's screen shows", async () => {
    const runtime = at.runtime();
    const shipId = newId('ship');
    await runtime.start({ shipId, folder: at.folder(), command: ['sh', '-c', 'echo "Ran 1 shell command"; sleep 30'] });

    await expect.poll(async () => runtime.screen(shipId), POLL).toContain('Ran 1 shell command');
  });

  it('reads an empty screen for a ship with no session', async () => {
    await expect(at.runtime().screen(newId('ship'))).resolves.toBe('');
  });

  it('stops a session', async () => {
    const runtime = at.runtime();
    const shipId = newId('ship');
    await runtime.start({ shipId, folder: at.folder(), command: ['sleep', '30'] });

    await runtime.stop(shipId);

    await expect(runtime.list()).resolves.toEqual([]);
  });
}
