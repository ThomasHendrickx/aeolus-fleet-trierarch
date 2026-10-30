import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../../test/support/in-memory.js';
import { buildTestSessionImage, rootlessPodman } from '../../test/support/podman.js';
import { USER_SYSTEMD_TESTS_VARIABLE, userSystemd } from '../../test/support/user-systemd.js';
import { createContainerRuntime } from './container.js';
import { trierarchPaths } from './paths.js';
import { runCommand } from './run-command.js';
import { createService, serviceEnvironment, SYSTEMD_UNIT } from './service.js';
import { TRIERARCH_PROGRAM } from '../../test/support/hold-program.js';
import { createHoldRuntime, sessionsLaunch } from './hold-runtime.js';
import { runningVersion } from './version.js';

// The unit the trierarch writes, run by the real systemd user manager under a
// name of the test's own. Its command starts a sleep, standing in for any
// process the trierarch starts outside its service, the way the trierarch
// starts its sessions' holds: in a scope of its own. The user manager is the
// machine's own, the one a live trierarch runs under, so the tests run only
// where AEOLUS_TEST_USER_SYSTEMD=1 asks for them, as CI does on a runner that
// hosts no trierarch (#886), and there wherever the user manager starts units,
// degraded included; elsewhere each test skips, saying why (#552). Each test proves it leaves nothing on the machine (#537):
// no unit, no scope, no process.

const systemd = await userSystemd({ isAskedFor: process.env[USER_SYSTEMD_TESTS_VARIABLE] === '1', platform: process.platform, isSystemRunning: () => runCommand('systemctl', { args: ['--user', 'is-system-running'] }) });

const SESSION_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 60_000;

/** How the trierarch starts a session's hold under a systemd unit. */
const UNDER_SYSTEMD = sessionsLaunch({ platform: 'linux', env: { INVOCATION_ID: 'test' } });

let folder: string;
let name: string;
/** Where the stand-in session writes its pid as it starts. */
let pidFile: string;
let unitFile: string;
/** The scopes the test's stand-in sessions ran in, each to be gone when the test ends. */
let scopes: string[];

const systemctl = (...args: string[]) => runCommand('systemctl', { args: ['--user', ...args] });
const loadState = async (unit: string) => (await systemctl('show', unit, '-p', 'LoadState', '--value')).stdout.trim();
/** The stand-in session's pid while it runs, so one the restarted command starts anew is told apart from the one kept; empty once it runs no more. */
const sessionPid = async () => {
  const pid = (await readFile(pidFile, 'utf8').catch(() => '')).trim();
  return pid !== '' && existsSync(`/proc/${pid}`) ? pid : '';
};
/** The unit a process runs in: the last part of its control group, as `run-r1.scope`. */
const unitOf = (pid: string) => readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim().split('/').at(-1) ?? '';

/** Writes the trierarch's unit under the test's name, its command starting a stand-in session detached as the trierarch starts a hold, and starts it until the session runs. */
async function startTheUnit(): Promise<void> {
  const script = join(folder, 'trierarch.sh');
  writeFileSync(script, `[ -s ${pidFile} ] || ${UNDER_SYSTEMD.join(' ')} sh -c 'echo $$ > ${pidFile}; exec sleep 300' < /dev/null > /dev/null 2>&1 &\nexec sleep 300\n`);
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
  await expect.poll(sessionPid, { timeout: SESSION_TIMEOUT_MS }).not.toBe('');
}

describe('the systemd user unit on this machine', () => {
  // First, so a skip runs neither the setup nor the cleanup, which need systemctl.
  beforeEach((context) => {
    if (!systemd.isUsable) {
      context.skip(systemd.reason);
    }
  });

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'trierarch-systemd-'));
    const suffix = folder.slice(-6).toLowerCase().replaceAll(/[^a-z0-9]/g, 'x');
    name = `aeolus-trierarch-test-${suffix}.service`;
    pidFile = join(folder, 'session.pid');
    unitFile = join(homedir(), '.config', 'systemd', 'user', name);
    scopes = [];
  });

  afterEach(async () => {
    await systemctl('stop', name);
    rmSync(unitFile, { force: true });
    await systemctl('daemon-reload');
    await systemctl('reset-failed', name);
    const pid = await sessionPid();
    if (pid !== '') {
      process.kill(Number(pid), 'SIGTERM');
    }
    rmSync(folder, { recursive: true, force: true });

    await expect.poll(async () => Promise.all([name, ...scopes].map(loadState))).toEqual([name, ...scopes].map(() => 'not-found'));
  });

  it(
    'keeps the sessions the trierarch started running across a stop and a restart of the service (#479)',
    async () => {
      await startTheUnit();
      const started = await sessionPid();
      scopes.push(unitOf(started));

      await systemctl('restart', name);
      const afterRestart = await sessionPid();
      await systemctl('stop', name);

      expect({ afterRestart, afterStop: await sessionPid() }).toEqual({ afterRestart: started, afterStop: started });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "runs a session outside the service's control group, so a restart finds no session of its run before in it (#537)",
    async () => {
      await startTheUnit();
      const scope = unitOf(await sessionPid());
      scopes.push(scope);

      expect(scope).toMatch(/\.scope$/);
    },
    TEST_TIMEOUT_MS,
  );

  it("starts each session's hold in a scope of its own under a systemd unit (headless H8)", async () => {
    const runtime = createHoldRuntime({ sessions: join(folder, 'sessions'), program: TRIERARCH_PROGRAM, version: runningVersion(), platform: 'linux', launch: UNDER_SYSTEMD });
    const shipId = newId('ship');

    await runtime.start({ shipId, folder, command: ['sleep', '30'], harness: 'claude-code' });

    const scope = unitOf(String(await runtime.sessionRootOf(shipId)));
    scopes.push(scope);
    await runtime.stop(shipId);
    expect({ isScope: scope.endsWith('.scope'), isThisProcess: scope === unitOf(String(process.pid)) }).toEqual({ isScope: true, isThisProcess: false });
  });
});

/** Container sessions need the user manager and a rootless Podman both. */
const podman = systemd.isUsable ? await rootlessPodman({ platform: process.platform, info: () => runCommand('podman', { args: ['info', '--format', '{{.Host.Security.Rootless}}'] }) }) : systemd;

describe('container sessions under the systemd user unit on this machine', () => {
  let image = '';
  let containerFolder: string;
  let container: string;
  let scope: string;

  // First, so a skip runs neither the setup nor the cleanup, which need systemctl and podman.
  beforeEach((context) => {
    if (!podman.isUsable) {
      context.skip(podman.reason);
    }
  });

  beforeAll(async () => {
    if (podman.isUsable) {
      image = await buildTestSessionImage(`localhost/aeolus-trierarch-test:${newId('ship').slice(-8)}`);
    }
  }, 60_000);

  afterAll(async () => {
    if (image !== '') {
      await runCommand('podman', { args: ['image', 'rm', '--force', image] });
    }
  });

  beforeEach(() => {
    containerFolder = mkdtempSync(join(tmpdir(), 'trierarch-systemd-container-'));
    container = '';
    scope = '';
  });

  afterEach(async () => {
    if (container !== '') {
      await runCommand('podman', { args: ['rm', '--force', '--time', '0', container] });
    }
    rmSync(containerFolder, { recursive: true, force: true });
    if (scope !== '') {
      await expect.poll(async () => loadState(scope)).toBe('not-found');
    }
  });

  it("starts the container's monitor in a scope of its own under a systemd unit, so a restart or upgrade of the service ends no session (#479, #537)", async () => {
    const tokenFile = join(containerFolder, 'model-token');
    writeFileSync(tokenFile, 'sk-ant-oat01-test-token\n', { mode: 0o600 });
    const shipId = newId('ship');
    const runtime = createContainerRuntime({ binary: 'podman', image, tokenFile, homes: join(containerFolder, 'homes'), sockets: join(containerFolder, 'sockets'), sessions: join(containerFolder, 'sessions'), program: TRIERARCH_PROGRAM, version: runningVersion(), platform: 'linux', memory: '512m', cpus: 1, owner: `trierarch-test-${shipId.slice(-8)}`, launch: UNDER_SYSTEMD });

    await runtime.start({ shipId, folder: containerFolder, command: ['sleep', '30'], harness: 'claude-code' });

    container = `trierarch-${shipId}`;
    // The start returns once the hold answers, which is before its `podman run` has created the container and started its monitor: the monitor's pid is read once the container runs.
    const monitorPid = async () => {
      const inspected = await runCommand('podman', { args: ['inspect', '--format', '{{.State.Running}} {{.State.ConmonPid}}', container] });
      const [isRunning, pid = ''] = inspected.stdout.trim().split(' ');
      return inspected.status === 0 && isRunning === 'true' && pid !== '0' ? pid : '';
    };
    await expect.poll(monitorPid, { timeout: SESSION_TIMEOUT_MS }).not.toBe('');
    scope = unitOf(await monitorPid());
    expect({ isScope: scope.endsWith('.scope'), isThisProcess: scope === unitOf(String(process.pid)) }).toEqual({ isScope: true, isThisProcess: false });
  });
});
