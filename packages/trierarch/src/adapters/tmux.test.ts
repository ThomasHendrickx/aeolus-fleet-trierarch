import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { setTimeout as wait } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newId } from '../../test/support/in-memory.js';
import { sessionRuntimeContract } from '../../test/support/session-runtime-contract.js';
import { runCommand } from './run-command.js';
import { HOLD_AFTER_EXIT_MS } from './held-command.js';
import { createTmux, sessionsLaunch } from './tmux.js';

// Against the real tmux, on a tmux server of the test's own, its socket in the
// test's own folder: kill-server leaves the socket behind (#537). The folder
// sits under /tmp, not $TMPDIR: on macOS $TMPDIR is so long that the socket path
// passes the Unix socket limit of 104 bytes (#559). tmux resolves the folder to
// its real path (/private/tmp on macOS), so the test holds that path.
const SOCKET_ROOT = '/tmp';

let server: string;
let folder: string;
let tmux: ReturnType<typeof createTmux>;

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
  it("runs the session's command held a moment after it ends, so its last output reaches the screen (#888)", async () => {
    const shipId = newId('ship');

    await tmux.start({ shipId, folder, command: ['sleep', '30'] });

    const shown = await runCommand('tmux', { args: ['-L', server, 'display-message', '-p', '-t', `=trierarch-${shipId}:`, '#{pane_start_command}'] });
    // tmux shows the start command quoted its own way, so the test looks for the hold in it.
    expect(shown.stdout).toContain(`sleep ${String(HOLD_AFTER_EXIT_MS / 1000)}`);
  });

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

/** The parents of a process up to the machine's first, through ps, which Linux and macOS both have. */
async function ancestorsOf(pid: number): Promise<number[]> {
  const ancestors: number[] = [];
  for (let current = pid; current > 1; ) {
    const parent = Number((await runCommand('ps', { args: ['-o', 'ppid=', '-p', String(current)] })).stdout.trim());
    if (!Number.isInteger(parent) || parent < 1) {
      break;
    }
    ancestors.push(parent);
    current = parent;
  }
  return ancestors;
}

describe("a session's root: the process its ship's session runs under, for the socket's caller check (decision 0026)", () => {
  it("is the session's pane, which every process of the session's command runs under", async () => {
    const shipId = newId('ship');
    const pidFile = join(folder, 'command.pid');

    await tmux.start({ shipId, folder, command: ['sh', '-c', `echo $$ > ${pidFile}; sleep 30`] });

    await expect.poll(() => existsSync(pidFile), { timeout: 5000 }).toBe(true);
    const root = await tmux.sessionRootOf(shipId);
    expect(root).toBeTypeOf('number');
    const command = Number(readFileSync(pidFile, 'utf8'));
    expect([command, ...(await ancestorsOf(command))]).toContain(root);
  });

  it('is none for a ship with no session', async () => {
    await expect(tmux.sessionRootOf(newId('ship'))).resolves.toBeUndefined();
  });
});

describe('a tmux server another process started (#883)', () => {
  /** Starts the server on the trierarch's socket as a process with its own variables would, such as a ship's session. */
  async function startServerFrom(variables: Readonly<Record<string, string>>): Promise<void> {
    const assignments = Object.entries(variables).map(([variable, value]) => `${variable}=${value}`);
    const started = await runCommand('env', { args: [...assignments, 'tmux', '-L', server, 'new-session', '-d', '-s', 'elsewhere', 'sleep 30'] });
    expect(started.status).toBe(0);
  }

  /** The environment a session the trierarch starts sees, one line per variable. */
  async function environmentOfASession(env: Readonly<Record<string, string>> = {}): Promise<string[]> {
    const written = join(folder, 'environment');
    await tmux.start({ shipId: newId('ship'), folder, command: ['sh', '-c', `env > ${written}.part && mv ${written}.part ${written}; sleep 30`], env });
    for (let tries = 0; tries < 100 && !existsSync(written); tries += 1) {
      await wait(50);
    }
    return readFileSync(written, 'utf8').split('\n');
  }

  it("gives a session none of that process's own variables", async () => {
    // The trierarch has neither, as a service; a test run inside a session may.
    vi.stubEnv('AEOLUS_FOLDER', undefined);
    vi.stubEnv('CLAUDECODE', undefined);
    await startServerFrom({ AEOLUS_FOLDER: '/home/another-ship', CLAUDECODE: '1' });

    const environment = await environmentOfASession();

    expect(environment.filter((line) => line.startsWith('AEOLUS_FOLDER=') || line.startsWith('CLAUDECODE='))).toEqual([]);
  });

  it("gives a session the trierarch's own value of a variable that process changed", async () => {
    vi.stubEnv('AEOLUS_TEST_OWN', 'the trierarch');
    await startServerFrom({ AEOLUS_TEST_OWN: 'another ship' });

    const environment = await environmentOfASession();

    expect(environment.filter((line) => line.startsWith('AEOLUS_TEST_OWN='))).toEqual(['AEOLUS_TEST_OWN=the trierarch']);
  });

  it('gives a session the variables the trierarch sets for it', async () => {
    await startServerFrom({ AEOLUS_FOLDER: '/home/another-ship' });

    const environment = await environmentOfASession({ AEOLUS_LAUNCH: 'launch-1' });

    expect(environment).toContain('AEOLUS_LAUNCH=launch-1');
  });
});

describe("a session and the trierarch's tmux server (#880)", () => {
  /** Waits for a file a session writes, then reads it. */
  async function written(path: string): Promise<string> {
    for (let tries = 0; tries < 100 && !existsSync(path); tries += 1) {
      await wait(50);
    }
    return readFileSync(path, 'utf8');
  }

  it('gives a session no TMUX or TMUX_PANE that names the server', async () => {
    const file = join(folder, 'environment');
    await tmux.start({ shipId: newId('ship'), folder, command: ['sh', '-c', `env > ${file}.part && mv ${file}.part ${file}; sleep 30`] });

    const environment = (await written(file)).split('\n');

    expect(environment.filter((line) => line.startsWith('TMUX=') || line.startsWith('TMUX_PANE='))).toEqual([]);
  });

  it("leaves the trierarch's server and the other sessions running when a session runs a bare tmux kill-server", async () => {
    const other = newId('ship');
    await tmux.start({ shipId: other, folder, command: ['sleep', '30'] });
    const done = join(folder, 'killed');
    // A bare tmux in the session, as a test script would run it; its default socket is in the test's own folder.
    await tmux.start({ shipId: newId('ship'), folder, command: ['sh', '-c', `TMUX_TMPDIR=${folder} tmux kill-server; touch ${done}; sleep 30`] });
    await written(done);

    await expect(tmux.list()).resolves.toContainEqual({ shipId: other, status: 'running' });
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
