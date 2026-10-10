import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newId } from '../../test/support/in-memory.js';
import { trierarchPaths } from './paths.js';
import { runCommand } from './run-command.js';
import { createService, serviceEnvironment, SYSTEMD_UNIT } from './service.js';
import { createTmux, sessionsLaunch } from './tmux.js';

// The unit the trierarch writes, run by the real systemd user manager under a
// name of the test's own, so the machine's own trierarch is left alone. Its
// command starts a tmux server the way the trierarch starts its sessions, in a
// scope of its own. Runs only where a systemd user manager answers (a Linux
// desktop or host, not CI). Each test proves it leaves nothing on the machine
// (#537): no unit, no scope, no tmux server, no socket.

const hasUserSystemd = process.platform === 'linux' && (await runCommand('systemctl', { args: ['--user', 'is-system-running'] }).catch(() => ({ status: 1 }))).status === 0;

const SESSION_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 60_000;

/** How the trierarch launches its tmux server under a systemd unit. */
const UNDER_SYSTEMD = sessionsLaunch({ platform: 'linux', env: { INVOCATION_ID: 'test' } });

let folder: string;
let name: string;
let socket: string;
let unitFile: string;
/** The scopes the test's tmux servers ran in, each to be gone when the test ends. */
let scopes: string[];

const systemctl = (...args: string[]) => runCommand('systemctl', { args: ['--user', ...args] });
const loadState = async (unit: string) => (await systemctl('show', unit, '-p', 'LoadState', '--value')).stdout.trim();
/** The tmux server's pid, so a server the restarted command starts anew is told apart from the one kept. */
const serverPid = async () => (await runCommand('tmux', { args: ['-S', socket, 'display-message', '-p', '#{pid}'] })).stdout.trim();
/** The unit a process runs in: the last part of its control group, as `run-r1.scope`. */
const unitOf = (pid: string) => readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim().split('/').at(-1) ?? '';

/** Writes the trierarch's unit under the test's name, its command starting a tmux server as the trierarch does, and starts it until the server runs. */
async function startTheUnit(): Promise<void> {
  const script = join(folder, 'trierarch.sh');
  writeFileSync(script, `${[...UNDER_SYSTEMD, 'tmux', '-S', socket].join(' ')} new-session -d -s session sleep 300\nexec sleep 300\n`);
  await createService({
    platform: 'linux',
    homeDirectory: folder,
    paths: trierarchPaths({ homeDirectory: folder }),
    run: { node: '/bin/sh', script },
    environment: serviceEnvironment(process.env),
    uid: process.getuid?.() ?? 0,
    exec: (command, args) => runCommand(command, { args }),
    now: () => new Date(),
  }).write();
  mkdirSync(dirname(unitFile), { recursive: true });
  writeFileSync(unitFile, readFileSync(join(folder, '.config', 'systemd', 'user', SYSTEMD_UNIT), 'utf8'));
  await systemctl('daemon-reload');
  await systemctl('start', name);
  await expect.poll(serverPid, { timeout: SESSION_TIMEOUT_MS }).not.toBe('');
}

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'trierarch-systemd-'));
  const suffix = folder.slice(-6).toLowerCase().replaceAll(/[^a-z0-9]/g, 'x');
  name = `aeolus-trierarch-test-${suffix}.service`;
  socket = join(folder, 'tmux.socket');
  unitFile = join(homedir(), '.config', 'systemd', 'user', name);
  scopes = [];
  // The tmux the test runs itself keeps its socket in the test's folder too.
  vi.stubEnv('TMUX_TMPDIR', folder);
});

afterEach(async () => {
  await systemctl('stop', name);
  rmSync(unitFile, { force: true });
  await systemctl('daemon-reload');
  await systemctl('reset-failed', name);
  await runCommand('tmux', { args: ['-S', socket, 'kill-server'] });
  await runCommand('tmux', { args: ['-L', 'sessions', 'kill-server'] });
  rmSync(folder, { recursive: true, force: true });
  vi.unstubAllEnvs();

  await expect.poll(async () => Promise.all([name, ...scopes].map(loadState))).toEqual([name, ...scopes].map(() => 'not-found'));
});

describe.runIf(hasUserSystemd)('the systemd user unit on this machine', () => {
  it(
    'keeps the sessions in the tmux server the trierarch started running across a stop and a restart of the service (#479)',
    async () => {
      await startTheUnit();
      const started = await serverPid();
      scopes.push(unitOf(started));

      await systemctl('restart', name);
      const afterRestart = await serverPid();
      await systemctl('stop', name);

      expect({ afterRestart, afterStop: await serverPid() }).toEqual({ afterRestart: started, afterStop: started });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "runs the tmux server outside the service's control group, so a restart finds no tmux server of its run before (#537)",
    async () => {
      await startTheUnit();
      const scope = unitOf(await serverPid());
      scopes.push(scope);

      expect(scope).toMatch(/\.scope$/);
    },
    TEST_TIMEOUT_MS,
  );

  it('starts the trierarch tmux server in a scope of its own under a systemd unit', async () => {
    const tmux = createTmux({ server: 'sessions', launch: UNDER_SYSTEMD });

    await tmux.start({ shipId: newId('ship'), folder, command: ['sleep', '30'] });

    const pid = (await runCommand('tmux', { args: ['-L', 'sessions', 'display-message', '-p', '#{pid}'] })).stdout.trim();
    const scope = unitOf(pid);
    scopes.push(scope);
    expect({ isScope: scope.endsWith('.scope'), isThisProcess: scope === unitOf(String(process.pid)) }).toEqual({ isScope: true, isThisProcess: false });
  });
});
