import type { ShipId } from '@aeolus-fleet/common';
import { expect, it } from 'vitest';

import type { SessionRuntime } from '../../src/core/ports.js';
import { newId } from './in-memory.js';

/** The harness every contract session is started for: a shell command stands in for it. */
const HARNESS = 'claude-code';

/** What the session's harness wrote, as one text. */
async function shown(runtime: SessionRuntime, shipId: ShipId): Promise<string> {
  return (await runtime.events(shipId)).join('\n');
}

/**
 * What every session runtime does (decision 0039), so the reconciler, the
 * launch window and wakes behave the same whichever runs the sessions. Each
 * adapter's test calls it inside its own describe, with a fresh runtime and an
 * empty folder per test. How a turn is stopped depends on the harness, so each
 * adapter's own test proves its interrupt.
 */
export function sessionRuntimeContract(at: { runtime: () => SessionRuntime; folder: () => string }): void {
  const POLL = { timeout: 5000 };

  it('lists none before any starts', async () => {
    await expect(at.runtime().list()).resolves.toEqual([]);
  });

  it('starts the command in the folder, in a session for the ship, and lists it running', async () => {
    const runtime = at.runtime();
    const shipId = newId('ship');

    await runtime.start({ shipId, folder: at.folder(), command: ['sh', '-c', 'echo "in $(pwd)"; sleep 30'], harness: HARNESS });

    // A start returns once the hold answers, which a container runtime does before its container exists: the list shows it running once it does.
    await expect.poll(async () => runtime.list(), POLL).toEqual([{ shipId, status: 'running' }]);
    await expect.poll(async () => shown(runtime, shipId), POLL).toContain(`in ${at.folder()}`);
  });

  it('starts the command with the environment given, such as its launch id (#490)', async () => {
    const runtime = at.runtime();
    const shipId = newId('ship');

    await runtime.start({ shipId, folder: at.folder(), command: ['sh', '-c', 'echo "launch $AEOLUS_LAUNCH"; sleep 30'], env: { AEOLUS_LAUNCH: 'launch-1' }, harness: HARNESS });

    await expect.poll(async () => shown(runtime, shipId), POLL).toContain('launch launch-1');
  });

  it('keeps a session whose command ended, so the exit is seen', async () => {
    const runtime = at.runtime();
    const shipId = newId('ship');

    await runtime.start({ shipId, folder: at.folder(), command: ['sh', '-c', 'exit 3'], harness: HARNESS });

    await expect.poll(async () => runtime.list(), POLL).toEqual([{ shipId, status: 'exited' }]);
  });

  it('reads the events of a session whose command ended, so the launch window names what stopped it', async () => {
    const runtime = at.runtime();
    const shipId = newId('ship');
    // The command ends only once its text is shown: a command that exits at once can end before a terminal has drawn its output (#859).
    await runtime.start({ shipId, folder: at.folder(), command: ['sh', '-c', 'echo "Invalid API key"; read line; exit 1'], harness: HARNESS });
    await expect.poll(async () => shown(runtime, shipId), POLL).toContain('Invalid API key');
    await runtime.send({ shipId, line: 'end' });
    await expect.poll(async () => runtime.list(), POLL).toEqual([{ shipId, status: 'exited' }]);

    await expect(shown(runtime, shipId)).resolves.toContain('Invalid API key');
  });

  it('replaces an exited session when the ship starts again', async () => {
    const runtime = at.runtime();
    const shipId = newId('ship');
    await runtime.start({ shipId, folder: at.folder(), command: ['sh', '-c', 'exit 3'], harness: HARNESS });
    await expect.poll(async () => runtime.list(), POLL).toEqual([{ shipId, status: 'exited' }]);

    await runtime.start({ shipId, folder: at.folder(), command: ['sleep', '30'], harness: HARNESS });

    await expect.poll(async () => runtime.list(), POLL).toEqual([{ shipId, status: 'running' }]);
  });

  it("sends a line to the session's harness, as its next input", async () => {
    const runtime = at.runtime();
    const shipId = newId('ship');
    await runtime.start({ shipId, folder: at.folder(), command: ['sh', '-c', 'read line; echo "got $line"; sleep 30'], harness: HARNESS });

    await runtime.send({ shipId, line: '/aeolus-fleet:wake' });

    await expect.poll(async () => shown(runtime, shipId), POLL).toContain('got /aeolus-fleet:wake');
  });

  it('reads no events for a ship with no session', async () => {
    await expect(at.runtime().events(newId('ship'))).resolves.toEqual([]);
  });

  it('stops a session', async () => {
    const runtime = at.runtime();
    const shipId = newId('ship');
    await runtime.start({ shipId, folder: at.folder(), command: ['sleep', '30'], harness: HARNESS });

    await runtime.stop(shipId);

    await expect(runtime.list()).resolves.toEqual([]);
  });
}
