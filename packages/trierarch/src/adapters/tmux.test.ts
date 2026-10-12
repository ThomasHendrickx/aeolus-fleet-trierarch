import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newId } from '../../test/support/in-memory.js';
import { sessionRuntimeContract } from '../../test/support/session-runtime-contract.js';
import { runCommand } from './run-command.js';
import type { SessionRuntime } from '../core/ports.js';
import { createTmux, sessionsLaunch } from './tmux.js';

// Against the real tmux, on a tmux server of the test's own, its socket in the
// test's own folder: kill-server leaves the socket behind (#537). The folder
// sits under /tmp, not $TMPDIR: on macOS $TMPDIR is so long that the socket path
// passes the Unix socket limit of 104 bytes (#559). tmux resolves the folder to
// its real path (/private/tmp on macOS), so the test holds that path.
const SOCKET_ROOT = '/tmp';

let server: string;
let folder: string;
let tmux: SessionRuntime;

beforeEach(() => {
  server = `trierarch-test-${newId('ship').slice(-8)}`;
  folder = realpathSync(mkdtempSync(join(SOCKET_ROOT, 'trierarch-tmux-')));
  vi.stubEnv('TMUX_TMPDIR', folder);
  tmux = createTmux({ server });
});

afterEach(async () => {
  await runCommand('tmux', { args: ['-L', server, 'kill-server'] });
  rmSync(folder, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('the session runtime contract, on tmux', () => {
  sessionRuntimeContract({ runtime: () => tmux, folder: () => folder });
});

describe('sessions in tmux', () => {
  it('names the session after the ship, in the folder', async () => {
    const shipId = newId('ship');

    await tmux.start({ shipId, folder, command: ['sleep', '30'] });

    const sessions = await runCommand('tmux', { args: ['-L', server, 'list-sessions', '-F', '#{session_name} #{pane_current_path}'] });
    expect(sessions.stdout.trim()).toMatch(new RegExp(`^trierarch-${shipId} .*${folder.split('/').at(-1) ?? ''}$`));
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

describe('where the tmux server starts (#537)', () => {
  it('starts the tmux server through the launch command it is given', async () => {
    const launched = createTmux({ server, launch: ['env', 'AEOLUS_LAUNCHED=yes'] });

    await launched.start({ shipId: newId('ship'), folder, command: ['sleep', '30'] });

    const shown = await runCommand('tmux', { args: ['-L', server, 'show-environment', '-g', 'AEOLUS_LAUNCHED'] });
    expect(shown.stdout.trim()).toBe('AEOLUS_LAUNCHED=yes');
  });

  it("launches through a systemd scope of its own under a systemd unit, so the service's restart finds no tmux server of its run before", () => {
    expect(sessionsLaunch({ platform: 'linux', env: { INVOCATION_ID: 'c0ffee' } })).toEqual(['systemd-run', '--user', '--scope', '--quiet', '--collect', '--']);
  });

  it('launches tmux itself on Linux outside a systemd unit', () => {
    expect(sessionsLaunch({ platform: 'linux', env: {} })).toEqual([]);
  });

  it('launches tmux itself on macOS, where launchd leaves the sessions running', () => {
    expect(sessionsLaunch({ platform: 'darwin', env: { INVOCATION_ID: 'c0ffee' } })).toEqual([]);
  });
});
