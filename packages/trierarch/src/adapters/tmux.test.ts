import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../../test/support/in-memory.js';
import { runCommand } from './run-command.js';
import { createTmux, type Tmux } from './tmux.js';

// Against the real tmux, on a tmux server of the test's own.

let server: string;
let folder: string;
let tmux: Tmux;

beforeEach(() => {
  server = `trierarch-test-${newId('ship').slice(-8)}`;
  folder = mkdtempSync(join(tmpdir(), 'trierarch-tmux-'));
  tmux = createTmux({ server });
});

afterEach(async () => {
  await runCommand('tmux', { args: ['-L', server, 'kill-server'] });
  rmSync(folder, { recursive: true, force: true });
});

describe('sessions in tmux', () => {
  it('lists none before any starts', async () => {
    await expect(tmux.list()).resolves.toEqual([]);
  });

  it("starts the command in the folder, in a session named after the ship, and lists it running", async () => {
    const shipId = newId('ship');

    await tmux.start({ shipId, folder, command: ['sleep', '30'] });

    await expect(tmux.list()).resolves.toEqual([{ shipId, status: 'running' }]);
    const sessions = await runCommand('tmux', { args: ['-L', server, 'list-sessions', '-F', '#{session_name} #{pane_current_path}'] });
    expect(sessions.stdout.trim()).toMatch(new RegExp(`^trierarch-${shipId} .*${folder.split('/').at(-1) ?? ''}$`));
  });

  it('keeps a session whose command ended, so the exit is seen', async () => {
    const shipId = newId('ship');

    await tmux.start({ shipId, folder, command: ['sh', '-c', 'exit 3'] });

    await expect.poll(async () => tmux.list(), { timeout: 5000 }).toEqual([{ shipId, status: 'exited' }]);
  });

  it('replaces an exited session when the ship starts again', async () => {
    const shipId = newId('ship');
    await tmux.start({ shipId, folder, command: ['sh', '-c', 'exit 3'] });
    await expect.poll(async () => tmux.list(), { timeout: 5000 }).toEqual([{ shipId, status: 'exited' }]);

    await tmux.start({ shipId, folder, command: ['sleep', '30'] });

    await expect(tmux.list()).resolves.toEqual([{ shipId, status: 'running' }]);
  });

  it('types text into the session and presses Enter', async () => {
    const shipId = newId('ship');
    await tmux.start({ shipId, folder, command: ['sh', '-c', 'read line; echo "got $line"; sleep 30'] });

    await tmux.type({ shipId, text: '/aeolus:wake' });

    await expect
      .poll(async () => (await runCommand('tmux', { args: ['-L', server, 'capture-pane', '-p', '-t', `=trierarch-${shipId}:`] })).stdout, { timeout: 5000 })
      .toContain('got /aeolus:wake');
  });

  it('waits the settle time between the text and Enter when asked', async () => {
    const shipId = newId('ship');
    const settleMs = 300;
    await tmux.start({ shipId, folder, command: ['sh', '-c', 'read line; echo "got $line"; sleep 30'] });
    const before = Date.now();

    await tmux.type({ shipId, text: '$aeolus-wake ', settleMs });

    expect(Date.now() - before).toBeGreaterThanOrEqual(settleMs);
    await expect
      .poll(async () => (await runCommand('tmux', { args: ['-L', server, 'capture-pane', '-p', '-t', `=trierarch-${shipId}:`] })).stdout, { timeout: 5000 })
      .toContain('got $aeolus-wake');
  });

  it("reads what the session's screen shows", async () => {
    const shipId = newId('ship');
    await tmux.start({ shipId, folder, command: ['sh', '-c', 'echo "Ran 1 shell command"; sleep 30'] });

    await expect.poll(async () => tmux.screen(shipId), { timeout: 5000 }).toContain('Ran 1 shell command');
  });

  it('reads an empty screen for a ship with no session', async () => {
    await expect(tmux.screen(newId('ship'))).resolves.toBe('');
  });

  it('stops a session', async () => {
    const shipId = newId('ship');
    await tmux.start({ shipId, folder, command: ['sleep', '30'] });

    await tmux.stop(shipId);

    await expect(tmux.list()).resolves.toEqual([]);
  });

  it('lists only its own sessions', async () => {
    await runCommand('tmux', { args: ['-L', server, 'new-session', '-d', '-s', 'thomas', 'sleep 30'] });

    await expect(tmux.list()).resolves.toEqual([]);
  });

  it("keeps the test's tmux server in the test's own folder, so the test leaves no socket on the machine (#537)", async () => {
    await tmux.start({ shipId: newId('ship'), folder, command: ['sleep', '30'] });

    const socket = await runCommand('tmux', { args: ['-L', server, 'display-message', '-p', '#{socket_path}'] });

    // tmux keeps its sockets in $TMUX_TMPDIR/tmux-<uid>/.
    expect(dirname(dirname(socket.stdout.trim()))).toBe(folder);
  });
});
