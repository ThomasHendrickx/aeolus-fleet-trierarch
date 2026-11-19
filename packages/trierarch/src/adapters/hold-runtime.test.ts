import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { FAKE_CLAUDE_CODE, FAKE_CODEX, FAKE_COPILOT, TRIERARCH_PROGRAM } from '../../test/support/hold-program.js';
import { newId } from '../../test/support/in-memory.js';
import { sessionRuntimeContract } from '../../test/support/session-runtime-contract.js';
import { aShortHome } from '../../test/support/short-home.js';
import type { ObservedSession, SessionRuntime } from '../core/ports.js';
import { createCallerCheck } from './caller-check.js';
import { createHoldRuntime, sessionsLaunch, systemdVersionOf } from './hold-runtime.js';
import { runCommand } from './run-command.js';
import { runningVersion } from './version.js';

// Against real holds, each the trierarch program from source started as the
// trierarch starts it, running the stand-in for Claude Code in print mode
// with streamed JSON, or a shell command. The folders sit in the run's short folder: a Unix
// socket path is at most 104 bytes on macOS.

/** The version a hold states: the trierarch's own, which runs it. */
const VERSION = runningVersion();
/** macOS gives every process this variable itself, even one started with an empty environment: not the trierarch's. */
const MACOS_PROCESS_VARIABLE = '__CF_USER_TEXT_ENCODING';
/** A user line as Claude Code takes it on stdin. */
const userLine = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
/** Puts a variable of this process's environment back as it was before a test set it. */
const restore = (variable: string, value: string | undefined): void => {
  if (value === undefined) Reflect.deleteProperty(process.env, variable);
  else process.env[variable] = value;
};

let sessions: string;
let folder: string;
let runtimes: SessionRuntime[];

beforeEach(() => {
  sessions = realpathSync(aShortHome('aeolus-holds'));
  folder = realpathSync(aShortHome('aeolus-folder'));
  runtimes = [];
});

afterEach(async () => {
  for (const runtime of runtimes) {
    for (const session of await runtime.list()) {
      await runtime.stop(session.shipId);
    }
  }
  rmSync(sessions, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
});

/** A hold runtime over the test's sessions folder; a second one over the same folder is the trierarch started again. */
/** Twenty turns started and interrupted, each a stdin line and a poll of the events. */
const TWENTY_TURNS_MS = 30_000;

function aRuntime(at: { version?: string; beside?: Pick<SessionRuntime, 'list' | 'stop'>; bootedAt?: () => Date; launch?: readonly string[]; program?: readonly string[]; shipsRoot?: string; modelTokenFile?: string; hasHostContainerStorage?: boolean } = {}) {
  const runtime = createHoldRuntime({ sessions, program: at.program ?? TRIERARCH_PROGRAM, version: at.version ?? VERSION, platform: process.platform, ...(at.modelTokenFile !== undefined && { modelTokenFile: at.modelTokenFile }), ...(at.shipsRoot !== undefined && { shipsRoot: at.shipsRoot }), ...(at.hasHostContainerStorage === true && { hasHostContainerStorage: true }), ...(at.launch !== undefined && { launch: at.launch }), ...(at.beside !== undefined && { beside: at.beside }), ...(at.bootedAt !== undefined && { bootedAt: at.bootedAt }) });
  runtimes.push(runtime);
  return runtime;
}

/** What the stand-in wrote down in the folder, one JSON value per line. */
function written(file: string): unknown[] {
  const path = join(folder, file);
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line): unknown => JSON.parse(line))
    : [];
}

const eventSchema = z.looseObject({ type: z.string() });
const startSchema = z.object({ args: z.array(z.string()), env: z.record(z.string(), z.string()) });

/** The events of the session that are of the type given, parsed. */
async function eventsOfType(session: { runtime: SessionRuntime; shipId: ShipId }, type: string): Promise<z.infer<typeof eventSchema>[]> {
  return (await session.runtime.events(session.shipId)).flatMap((line) => {
    const event = eventSchema.safeParse(JSON.parse(line));
    return event.success && event.data.type === type ? [event.data] : [];
  });
}

/** Whether a process of that pid still runs. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Each start of the stand-in, as it wrote it down. */
const starts = () => written('fake-starts.jsonl').map((start) => startSchema.parse(start));

async function aClaudeCodeSession(runtime: SessionRuntime, flags: readonly string[] = []): Promise<ShipId> {
  const shipId = newId('ship');
  await runtime.start({ shipId, folder, command: [...FAKE_CLAUDE_CODE, ...flags], harness: 'claude-code' });
  return shipId;
}

it.runIf(process.platform === 'linux')("starts a ship's Podman service beside its host session and stops it with the session", async () => {
  const runtime = aRuntime({ hasHostContainerStorage: true });
  const shipId = newId('ship');
  const shipFolder = join(sessions, shipId + '-ship');
  await runtime.start({ shipId, shipFolder, folder, command: [...FAKE_CLAUDE_CODE], harness: 'claude-code' });

  await expect.poll(() => starts().length).toBeGreaterThan(0);
  const env = starts()[0]?.env;
  expect(env).toMatchObject({
    CONTAINERS_STORAGE_CONF: join(shipFolder, 'containers', 'storage.conf'),
    DOCKER_HOST: `unix://${shipFolder}/podman.sock`,
    CONTAINER_HOST: `unix://${shipFolder}/podman.sock`,
  });
  expect(existsSync(join(shipFolder, 'podman.sock'))).toBe(true);
  await runtime.stop(shipId);
  await expect.poll(() => existsSync(join(shipFolder, 'podman.sock'))).toBe(false);
});

it.runIf(process.platform === 'linux')("removes the ship's test volumes when its host session starts again", async () => {
  const runtime = aRuntime({ hasHostContainerStorage: true });
  const shipId = newId('ship');
  const shipFolder = join(sessions, shipId + '-ship');
  const session = { shipId, shipFolder, folder, command: [...FAKE_CLAUDE_CODE], harness: 'claude-code' };
  const url = `unix://${shipFolder}/podman.sock`;
  await runtime.start(session);
  const info = await runCommand('env', { args: ['-u', 'CONTAINER_HOST', '-u', 'DOCKER_HOST', 'podman', '--url', url, 'info', '--format', '{{.Store.GraphRoot}}'] });
  expect(info.stdout.trim()).toBe(join(shipFolder, 'containers', 'graph'));
  const made = await runCommand('env', { args: ['-u', 'CONTAINER_HOST', '-u', 'DOCKER_HOST', 'podman', '--url', url, 'volume', 'create', 'left-behind'] });
  expect(made.status).toBe(0);
  await runtime.start(session);
  const listed = await runCommand('env', { args: ['-u', 'CONTAINER_HOST', '-u', 'DOCKER_HOST', 'podman', '--url', url, 'volume', 'ls', '--format', '{{.Name}}'] });
  expect({ status: listed.status, volumes: listed.stdout.trim() }).toEqual({ status: 0, volumes: '' });
});

it.runIf(process.platform === 'linux')("cleans up a killed host session's Testcontainers container and volume on restart", async () => {
  const runtime = aRuntime({ hasHostContainerStorage: true });
  const shipId = newId('ship');
  const shipFolder = join(sessions, shipId + '-ship');
  const name = `test-${shipId}`;
  const ready = join(folder, 'testcontainers-ready');
  const program = `const { createRequire } = require('node:module');
    const { GenericContainer } = createRequire(${JSON.stringify(join(process.cwd(), 'package.json'))})('testcontainers');
    (async () => {
      await new GenericContainer('docker.io/library/postgres:17-alpine').withName(${JSON.stringify(name)}).withEnvironment({ POSTGRES_PASSWORD: 'test' }).start();
      require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');
      setInterval(() => {}, 1000);
    })().catch(e => { console.log(JSON.stringify({ type: 'error', message: String(e) })); process.exit(1); });`;
  const session = { shipId, shipFolder, folder, command: [process.execPath, '-e', program], harness: 'claude-code', env: { TESTCONTAINERS_RYUK_DISABLED: 'true', TESTCONTAINERS_HOST_OVERRIDE: '127.0.0.1' } };
  const url = `unix://${shipFolder}/podman.sock`;
  const client = (args: string[]) => runCommand('env', { args: ['-u', 'CONTAINER_HOST', '-u', 'DOCKER_HOST', 'podman', '--url', url, ...args] });
  try {
    await runtime.start(session);
    await expect.poll(() => existsSync(ready), { timeout: 180_000 }).toBe(true);
    const before = await client(['ps', '--all', '--filter', `name=${name}`, '--format', '{{.Names}}']);
    const volumes = await client(['volume', 'ls', '--quiet']);
    expect(before.stdout.trim()).toBe(name);
    expect(volumes.stdout.trim()).not.toBe('');
    await runtime.stop(shipId);
    await runtime.start({ ...session, command: [...FAKE_CLAUDE_CODE] });
    const after = await client(['ps', '--all', '--filter', `name=${name}`, '--quiet']);
    const remaining = await client(['volume', 'ls', '--quiet']);
    expect([after.stdout.trim(), remaining.stdout.trim()]).toEqual(['', '']);
    const own = await runCommand('env', { args: ['-u', 'CONTAINER_HOST', '-u', 'DOCKER_HOST', 'podman', 'ps', '--all', '--filter', `name=${name}`, '--quiet'] });
    expect(own.stdout.trim()).toBe('');
  } finally {
    await runtime.stop(shipId);
    const config = join(shipFolder, 'containers', 'storage.conf');
    if (existsSync(config)) {
      await runCommand('env', { args: ['-u', 'CONTAINER_HOST', '-u', 'DOCKER_HOST', `CONTAINERS_STORAGE_CONF=${config}`, 'podman', 'rm', '--all', '--force', '--time', '0', '--volumes'] });
      await runCommand('podman', { args: ['unshare', 'rm', '-rf', '--', shipFolder] });
    }
  }
}, 240_000);

it('stops a session when its hold exits before it can be signalled', async () => {
  const runtime = aRuntime();
  const shipId = await aClaudeCodeSession(runtime);
  const kill = process.kill.bind(process);
  const signal = vi.spyOn(process, 'kill').mockImplementation((pid, name) => {
    if (name === 'SIGTERM') {
      kill(pid, 'SIGKILL');
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    }
    return kill(pid, name);
  });
  try {
    await expect(runtime.stop(shipId)).resolves.toBeUndefined();
    expect(existsSync(join(sessions, shipId))).toBe(false);
  } finally {
    signal.mockRestore();
  }
});

it('fails to stop a session when signalling its hold is denied', async () => {
  const runtime = aRuntime();
  const shipId = await aClaudeCodeSession(runtime);
  const kill = process.kill.bind(process);
  const denied = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
  const signal = vi.spyOn(process, 'kill').mockImplementation((pid, name) => {
    if (name === 'SIGTERM') throw denied;
    return kill(pid, name);
  });
  try {
    await expect(runtime.stop(shipId)).rejects.toBe(denied);
  } finally {
    signal.mockRestore();
  }
});

it('empties the ship temp after stopping its session and points the host session there', async () => {
  const runtime = aRuntime();
  const shipId = newId('ship');
  const shipFolder = join(folder, 'ship');
  const temp = join(shipFolder, 'tmp');
  mkdirSync(temp, { recursive: true });
  writeFileSync(join(temp, 'old'), 'old');
  await runtime.start({ shipId, folder, shipFolder, command: [...FAKE_CLAUDE_CODE], harness: 'claude-code' });
  await expect.poll(() => starts().length).toBe(1);
  expect([existsSync(join(temp, 'old')), starts()[0]?.env.TMPDIR, starts()[0]?.env.TMP, starts()[0]?.env.TEMP]).toEqual([false, temp, temp, temp]);
  writeFileSync(join(temp, 'during'), 'running');
  expect(existsSync(join(temp, 'during'))).toBe(true);
  await runtime.start({ shipId, folder, shipFolder, command: [...FAKE_CLAUDE_CODE], harness: 'claude-code' });
  await expect.poll(() => starts().length).toBe(2);
  expect(existsSync(join(temp, 'during'))).toBe(false);
});

it.each(['stale guard marker', 'reused pid'])('starts after a machine restart with a %s and empties only its temp', { timeout: 15_000 }, async (record) => {
  const runtime = aRuntime();
  const shipId = newId('ship');
  const shipFolder = join(folder, 'ship');
  const temp = join(shipFolder, 'tmp');
  const previous = join(sessions, shipId);
  mkdirSync(temp, { recursive: true });
  mkdirSync(previous, { recursive: true });
  writeFileSync(join(temp, 'old'), 'old');
  writeFileSync(join(folder, 'outside'), 'keep');
  // This process belongs to the test, not to the persisted session.
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  try {
    await new Promise<void>((resolve, reject) => {
      unrelated.once('spawn', resolve);
      unrelated.once('error', reject);
    });
    if (unrelated.pid === undefined) throw new Error('the unrelated process did not start');
    writeFileSync(join(previous, 'hold.pid'), '2147483647');
    writeFileSync(join(previous, 'harness-sessions'), `${String(unrelated.pid)}\n`);
    if (record === 'stale guard marker') writeFileSync(join(previous, 'guard-active'), 'active');
    utimesSync(join(previous, 'hold.pid'), new Date(0), new Date(0));

    await runtime.start({ shipId, folder, shipFolder, command: [...FAKE_CLAUDE_CODE], harness: 'claude-code' });

    await expect.poll(() => starts().length).toBe(1);
    expect(readdirSync(temp)).toEqual([]);
    expect(readFileSync(join(folder, 'outside'), 'utf8')).toBe('keep');
    expect(isAlive(unrelated.pid)).toBe(true);
  } finally {
    const ended = new Promise((resolve) => unrelated.once('exit', resolve));
    if (unrelated.exitCode === null && unrelated.signalCode === null) {
      unrelated.kill('SIGKILL');
      await ended;
    }
  }
});

/** The guard belongs to the hold this test started, beside its recorded harness groups. */
async function guardOf(runtime: SessionRuntime & { sessionRootOf: (shipId: ShipId) => Promise<number | undefined> }, shipId: ShipId): Promise<number> {
  const hold = await runtime.sessionRootOf(shipId);
  const groups = readFileSync(join(sessions, shipId, 'harness-sessions'), 'utf8').trim().split('\n').map(Number);
  const listed = await runCommand('ps', { args: ['-A', '-o', 'pid=,ppid='] });
  const guard = listed.stdout.split('\n').map((line) => line.trim().split(/\s+/).map(Number)).find(([pid, parent]) => parent === hold && pid !== undefined && !groups.includes(pid))?.[0];
  if (guard === undefined) throw new Error('the test session has no guard');
  return guard;
}

it('starts after its guard crashes during the current boot, stopping the old session before emptying temp', { timeout: 20_000 }, async () => {
  const runtime = aRuntime();
  const shipId = newId('ship');
  const shipFolder = join(folder, 'ship');
  const temp = join(shipFolder, 'tmp');
  const previous = join(sessions, shipId);
  await runtime.start({ shipId, folder, shipFolder, command: ['sh', '-c', 'trap "" TERM; while :; do echo old > "$TMPDIR/writing"; sleep 0.1; done'], harness: 'claude-code' });
  await expect.poll(() => existsSync(join(temp, 'writing'))).toBe(true);
  const guard = await guardOf(runtime, shipId);
  const groups = readFileSync(join(previous, 'harness-sessions'), 'utf8').trim().split('\n').map(Number);
  process.kill(guard, 'SIGKILL');
  await expect.poll(() => isAlive(guard)).toBe(false);
  try {
    await runtime.start({ shipId, folder, shipFolder, command: [...FAKE_CLAUDE_CODE], harness: 'claude-code' });
    await expect.poll(() => starts().length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(readdirSync(temp)).toEqual([]);
  } finally {
    // The red run still owns a session whose guard cannot clean it up.
    rmSync(join(previous, 'guard-active'), { force: true });
    for (const group of groups) {
      try { process.kill(-group, 'SIGKILL'); } catch { /* The test session already ended. */ }
    }
  }
});

it('starts after a same-boot guard leaves a marker without an identity', { timeout: 15_000 }, async () => {
  const runtime = aRuntime();
  const shipId = newId('ship');
  const previous = join(sessions, shipId);
  mkdirSync(previous, { recursive: true });
  writeFileSync(join(previous, 'hold.pid'), '2147483647');
  writeFileSync(join(previous, 'guard-active'), 'active');
  try {
    await runtime.start({ shipId, folder, command: [...FAKE_CLAUDE_CODE], harness: 'claude-code' });
    await expect.poll(() => starts().length).toBe(1);
  } finally {
    rmSync(join(previous, 'guard-active'), { force: true });
  }
});

it('recovers when a same-boot guard marker points to an unrelated process', { timeout: 15_000 }, async () => {
  const runtime = aRuntime();
  const shipId = newId('ship');
  const previous = join(sessions, shipId);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    await new Promise<void>((resolve, reject) => {
      unrelated.once('spawn', resolve);
      unrelated.once('error', reject);
    });
    if (unrelated.pid === undefined) throw new Error('the unrelated process did not start');
    mkdirSync(previous, { recursive: true });
    writeFileSync(join(previous, 'hold.pid'), '2147483647');
    writeFileSync(join(previous, 'guard-active'), String(unrelated.pid));

    await runtime.start({ shipId, folder, command: [...FAKE_CLAUDE_CODE], harness: 'claude-code' });

    await expect.poll(() => starts().length).toBe(1);
    expect(isAlive(unrelated.pid)).toBe(true);
  } finally {
    rmSync(join(previous, 'guard-active'), { force: true });
    const ended = new Promise((resolve) => unrelated.once('exit', resolve));
    unrelated.kill('SIGKILL');
    await ended;
  }
});

it('keeps temp when a live guard has not finished stopping its session', { timeout: 20_000 }, async () => {
  const runtime = aRuntime();
  const shipId = newId('ship');
  const shipFolder = join(folder, 'ship');
  const temp = join(shipFolder, 'tmp');
  await runtime.start({ shipId, folder, shipFolder, command: ['sh', '-c', 'trap "" TERM; while :; do echo old > "$TMPDIR/writing"; sleep 0.1; done'], harness: 'claude-code' });
  await expect.poll(() => existsSync(join(temp, 'writing'))).toBe(true);
  const guard = await guardOf(runtime, shipId);
  process.kill(guard, 'SIGSTOP');
  try {
    await expect(runtime.start({ shipId, folder, shipFolder, command: [...FAKE_CLAUDE_CODE], harness: 'claude-code' })).rejects.toThrow(`the guard of ${shipId} did not finish stopping its session`);
    expect(existsSync(join(temp, 'writing'))).toBe(true);
  } finally {
    process.kill(guard, 'SIGCONT');
  }
});

it('waits for a stubborn session to end before emptying its temp', { timeout: 15_000 }, async () => {
  const runtime = aRuntime();
  const shipId = newId('ship');
  const shipFolder = join(folder, 'ship');
  const temp = join(shipFolder, 'tmp');
  await runtime.start({ shipId, folder, shipFolder, command: ['sh', '-c', 'trap "" TERM; while :; do echo old > "$TMPDIR/writing"; sleep 0.1; done'], harness: 'claude-code' });
  await expect.poll(() => existsSync(join(temp, 'writing'))).toBe(true);
  await runtime.start({ shipId, folder, shipFolder, command: [...FAKE_CLAUDE_CODE], harness: 'claude-code' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(existsSync(join(temp, 'writing'))).toBe(false);
});

it('waits for a stubborn session of an older hold before emptying temp', { timeout: 15_000 }, async () => {
  const runtime = aRuntime();
  const shipId = newId('ship');
  const shipFolder = join(folder, 'ship');
  const temp = join(shipFolder, 'tmp');
  await runtime.start({ shipId, folder, shipFolder, command: ['sh', '-c', 'trap "" TERM; while :; do echo old > "$TMPDIR/writing"; sleep 0.1; done'], harness: 'claude-code' });
  await expect.poll(() => existsSync(join(temp, 'writing'))).toBe(true);
  rmSync(join(sessions, shipId, 'guard-active'));
  await runtime.start({ shipId, folder, shipFolder, command: [...FAKE_CLAUDE_CODE], harness: 'claude-code' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(existsSync(join(temp, 'writing'))).toBe(false);
});

it('gives a ship crewed before ship folders its own temp without moving its workspace', async () => {
  const shipsRoot = join(folder, 'ships');
  const runtime = aRuntime({ shipsRoot });
  const shipId = newId('ship');
  const temp = join(shipsRoot, shipId, 'tmp');
  await runtime.start({ shipId, folder, command: [...FAKE_CLAUDE_CODE], harness: 'claude-code' });
  await expect.poll(() => starts().length).toBe(1);
  expect(starts()[0]?.env.TMPDIR).toBe(temp);
});

it('moves temp it cannot empty to the trash, logs it, and starts with an empty temp', async () => {
  const runtime = aRuntime();
  const shipId = newId('ship');
  const shipFolder = join(folder, 'ship');
  const temp = join(shipFolder, 'tmp');
  const locked = join(temp, 'locked');
  mkdirSync(locked, { recursive: true });
  writeFileSync(join(locked, 'left'), 'left');
  chmodSync(locked, 0o500);
  const logged = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await runtime.start({ shipId, folder, shipFolder, command: [...FAKE_CLAUDE_CODE], harness: 'claude-code' });
    expect(readdirSync(temp)).toEqual([]);
    const trashed = readdirSync(join(folder, '.trash'));
    expect(trashed).toHaveLength(1);
    expect(existsSync(join(folder, '.trash', trashed[0] ?? '', 'locked', 'left'))).toBe(true);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('moved it to the trash'));
    chmodSync(join(folder, '.trash', trashed[0] ?? '', 'locked'), 0o700);
  } finally {
    logged.mockRestore();
  }
});

it('moves two ships temp folders to the trash even at the same time', async () => {
  const runtime = aRuntime();
  const ships = [newId('ship'), newId('ship')];
  const trash = join(folder, '.trash');
  for (const shipId of ships) {
    const locked = join(folder, shipId, 'tmp', 'locked');
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, 'left'), shipId);
    chmodSync(locked, 0o500);
  }
  vi.setSystemTime(new Date('2026-11-19T00:00:00Z'));
  const logged = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    for (const shipId of ships) {
      await runtime.start({ shipId, folder, shipFolder: join(folder, shipId), command: [...FAKE_CLAUDE_CODE], harness: 'claude-code' });
    }
    const trashed = readdirSync(trash);
    expect(trashed).toHaveLength(2);
    for (const name of trashed) chmodSync(join(trash, name, 'locked'), 0o700);
  } finally {
    vi.useRealTimers();
    logged.mockRestore();
    for (const shipId of ships) {
      const locked = join(folder, shipId, 'tmp', 'locked');
      if (existsSync(locked)) chmodSync(locked, 0o700);
    }
    if (existsSync(trash)) for (const name of readdirSync(trash)) chmodSync(join(trash, name, 'locked'), 0o700);
  }
});

describe('the session runtime contract, on holds', () => {
  sessionRuntimeContract({ runtime: () => aRuntime(), folder: () => folder });
});

describe('a session held by a hold, Claude Code in print mode with streamed JSON (headless H8, H11)', () => {
  it("sends a hand-over as one line on the harness's stdin, and keeps every event line it writes", async () => {
    const runtime = aRuntime();
    const shipId = await aClaudeCodeSession(runtime);

    await runtime.send({ shipId, line: userLine('Review PR 12') });

    await expect.poll(async () => eventsOfType({ runtime: runtime, shipId: shipId }, 'result')).toEqual([expect.objectContaining({ subtype: 'success', result: 'got Review PR 12' })]);
    expect(written('fake-received.jsonl')).toEqual([JSON.parse(userLine('Review PR 12'))]);
  });

  it("keeps each session's events in its own folder, never another ship's", async () => {
    const runtime = aRuntime();
    const scout = await aClaudeCodeSession(runtime);
    const lookout = await aClaudeCodeSession(runtime);

    await runtime.send({ shipId: scout, line: userLine('for scout') });

    await expect.poll(async () => eventsOfType({ runtime: runtime, shipId: scout }, 'result')).toHaveLength(1);
    await expect(eventsOfType({ runtime: runtime, shipId: lookout }, 'result')).resolves.toEqual([]);
  });

  it('hands a host Claude subscription its machine token without putting it on the command line', async () => {
    const modelTokenFile = join(sessions, 'model-token');
    const token = 'test-model-token-not-real';
    writeFileSync(modelTokenFile, token);
    const runtime = aRuntime({ modelTokenFile });
    const shipId = await aClaudeCodeSession(runtime);
    await expect.poll(() => written('fake-starts.jsonl')).toHaveLength(1);
    expect(starts()[0]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(token);
    const holdPid = Number(readFileSync(join(sessions, shipId, 'hold.pid'), 'utf8'));
    const commandLine = (await runCommand('ps', { args: ['-o', 'args=', '-p', String(holdPid)] })).stdout;
    expect(commandLine).not.toContain(token);
  });

  it("hands the session its proxy token in the variable named, from a file of the session's own, never on a command line (api keys K7)", async () => {
    const modelTokenFile = join(sessions, 'model-token');
    writeFileSync(modelTokenFile, 'test-model-token-not-real');
    const runtime = aRuntime({ modelTokenFile });
    const shipId = newId('ship');
    const token = 'test-proxy-token-not-real';

    await runtime.start({ shipId, folder, command: [...FAKE_CLAUDE_CODE], env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:41234/anthropic' }, harness: 'claude-code', proxyToken: { harness: 'claude-code', variable: 'ANTHROPIC_AUTH_TOKEN', token } });

    await expect.poll(() => written('fake-starts.jsonl')).toHaveLength(1);
    const [start] = starts();
    expect(start?.env.ANTHROPIC_AUTH_TOKEN).toBe(token);
    expect(start?.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(start?.args.join(' ')).not.toContain(token);
    const tokenFile = join(sessions, shipId, 'proxy-token');
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    const holdPid = Number(readFileSync(join(sessions, shipId, 'hold.pid'), 'utf8'));
    const commandLine = (await runCommand('ps', { args: ['-o', 'args=', '-p', String(holdPid)] })).stdout;
    expect(commandLine).toContain(' hold ');
    expect(commandLine).not.toContain(token);
  });

  it("starts the harness with none of the trierarch's environment: only HOME, PATH, USER, LOGNAME and what the start gives (H10)", async () => {
    process.env.AEOLUS_TEST_TRIERARCH_SECRET = 'held by the trierarch';
    const { USER: user, LOGNAME: logname } = process.env;
    process.env.USER = 'held-user';
    process.env.LOGNAME = 'held-user';
    try {
      const runtime = aRuntime();
      const shipId = newId('ship');

      await runtime.start({ shipId, folder, command: [...FAKE_CLAUDE_CODE], env: { AEOLUS_LAUNCH: 'launch-1' }, harness: 'claude-code' });

      await expect.poll(() => written('fake-starts.jsonl')).toHaveLength(1);
      const [start] = starts();
      expect(Object.keys(start?.env ?? {}).filter((variable) => variable !== MACOS_PROCESS_VARIABLE).sort()).toEqual(['AEOLUS_LAUNCH', 'HOME', 'LOGNAME', 'PATH', 'USER']);
      expect(start?.env.AEOLUS_LAUNCH).toBe('launch-1');
    } finally {
      delete process.env.AEOLUS_TEST_TRIERARCH_SECRET;
      restore('USER', user);
      restore('LOGNAME', logname);
    }
  });

  it('runs on when the trierarch that started it is started again: a new trierarch lists it running and hands it lines', async () => {
    const shipId = await aClaudeCodeSession(aRuntime());

    const again = aRuntime();
    await again.send({ shipId, line: userLine('after the restart') });

    await expect(again.list()).resolves.toEqual([{ shipId, status: 'running' }]);
    await expect.poll(async () => eventsOfType({ runtime: again, shipId: shipId }, 'result')).toEqual([expect.objectContaining({ result: 'got after the restart' })]);
  });

  it('stops a running turn with the interrupt control request and waits for its end; the harness goes on and takes the next line (H12)', async () => {
    const runtime = aRuntime();
    const shipId = await aClaudeCodeSession(runtime);
    await runtime.send({ shipId, line: userLine('work slowly') });
    await expect.poll(async () => eventsOfType({ runtime: runtime, shipId: shipId }, 'assistant')).toHaveLength(1);

    await runtime.interrupt(shipId);

    await expect(eventsOfType({ runtime: runtime, shipId: shipId }, 'result')).resolves.toEqual([expect.objectContaining({ subtype: 'error_during_execution' })]);
    await runtime.send({ shipId, line: userLine('the forced one') });
    await expect.poll(async () => eventsOfType({ runtime: runtime, shipId: shipId }, 'result')).toHaveLength(2);
    expect(written('fake-starts.jsonl')).toHaveLength(1);
  });

  it('has the stopped turn in its events by the time an interrupt returns, every time (H12)', async () => {
    const runtime = aRuntime();
    const shipId = await aClaudeCodeSession(runtime);
    const turns = 20;

    for (let turn = 1; turn <= turns; turn += 1) {
      await runtime.send({ shipId, line: userLine(`work slowly ${String(turn)}`) });
      await expect.poll(async () => eventsOfType({ runtime: runtime, shipId: shipId }, 'assistant')).toHaveLength(turn);
      await runtime.interrupt(shipId);
      await expect(eventsOfType({ runtime: runtime, shipId: shipId }, 'result')).resolves.toHaveLength(turn);
    }
  }, TWENTY_TURNS_MS);

  it('stops a running turn with SIGINT when the harness refuses the control request, and starts it again resuming its session, with no exit seen (H12)', async () => {
    const runtime = aRuntime();
    const shipId = await aClaudeCodeSession(runtime, ['--refuse-interrupt']);
    await runtime.send({ shipId, line: userLine('work slowly') });
    await expect.poll(async () => eventsOfType({ runtime: runtime, shipId: shipId }, 'assistant')).toHaveLength(1);
    const [init] = await eventsOfType({ runtime: runtime, shipId: shipId }, 'system');

    await runtime.interrupt(shipId);
    await runtime.send({ shipId, line: userLine('the forced one') });

    await expect.poll(async () => eventsOfType({ runtime: runtime, shipId: shipId }, 'result')).toEqual([expect.objectContaining({ subtype: 'error_during_execution' }), expect.objectContaining({ result: 'got the forced one' })]);
    const args = starts().map((start) => start.args);
    expect(args).toHaveLength(2);
    expect(args[1]?.slice(-2)).toEqual(['--resume', init?.session_id]);
    await expect(runtime.list()).resolves.toEqual([{ shipId, status: 'running' }]);
  });

  it('ends its hold when the harness exits, and keeps its events, so the launch window reads why (H13)', async () => {
    const runtime = aRuntime();
    const shipId = await aClaudeCodeSession(runtime, ['--fail-login']);

    await runtime.send({ shipId, line: userLine('/aeolus-fleet:wake') });

    await expect.poll(async () => runtime.list()).toEqual([expect.objectContaining({ shipId, status: 'exited' })]);
    await expect(eventsOfType({ runtime: runtime, shipId: shipId }, 'result')).resolves.toEqual([expect.objectContaining({ is_error: true, result: 'Not logged in · Please run /login' })]);
  });

  it.each([
    { name: 'status', script: 'sleep 0.2; exit 2', reason: 'session process exited with code 2' },
    { name: 'signal', script: 'sleep 0.2; kill -KILL $$', reason: 'session process ended: signal: SIGKILL' },
  ])('keeps the process $name without a harness error event across a trierarch restart', async ({ script, reason }) => {
    const runtime = aRuntime();
    const shipId = newId('ship');
    await runtime.start({ shipId, folder, command: ['sh', '-c', script], harness: 'claude-code' });

    const restarted = aRuntime();
    await expect.poll(() => restarted.list(), { timeout: 2000 }).toEqual([{ shipId, status: 'exited', exitReason: reason }]);
  });

  it('says the exit reason is unknown when its hold dies without a record', async () => {
    const runtime = aRuntime();
    const shipId = await aClaudeCodeSession(runtime);
    const hold = await runtime.sessionRootOf(shipId);

    process.kill(hold ?? 0, 'SIGKILL');

    await expect.poll(async () => runtime.list(), { timeout: 2000 }).toEqual([{ shipId, status: 'exited', exitReason: 'session hold ended without an exit record' }]);
  });

  it('ends the harness, and every process it started, when its hold dies abruptly (H8)', async () => {
    const runtime = aRuntime();
    const shipId = newId('ship');
    // Neither reads stdin, so neither ends when the hold's end of it closes.
    await runtime.start({ shipId, folder, command: ['sh', '-c', 'echo $$ > harness.pid; sleep 600 & echo $! > started.pid; wait'], harness: 'claude-code' });
    await expect.poll(() => existsSync(join(folder, 'started.pid'))).toBe(true);
    const pids = ['harness.pid', 'started.pid'].map((file) => Number(readFileSync(join(folder, file), 'utf8').trim()));

    process.kill((await runtime.sessionRootOf(shipId)) ?? 0, 'SIGKILL');

    await expect.poll(() => pids.filter(isAlive), { timeout: 3_000 }).toEqual([]);
  });

  it('lists a session whose hold another version of the trierarch started as of another version, as after an upgrade (H19)', async () => {
    const shipId = await aClaudeCodeSession(aRuntime());

    await expect(aRuntime({ version: '99.0.0' }).list()).resolves.toEqual([{ shipId, status: 'running', isOtherVersion: true }]);
  });

  it('lists no session whose hold started before the machine did, as after a restart of the machine', async () => {
    const shipId = await aClaudeCodeSession(aRuntime());
    await expect(aRuntime().list()).resolves.toEqual([{ shipId, status: 'running' }]);

    await expect(aRuntime({ bootedAt: () => new Date(Date.now() + 60_000) }).list()).resolves.toEqual([]);
  });

  it('lists what runs beside the holds for a ship no hold holds as of another version, as an older trierarch left it, and stops it before the ship starts under a hold', async () => {
    const shipId = newId('ship');
    const older = new Map<ShipId, ObservedSession['status']>([[shipId, 'running']]);
    const beside = {
      list: () => Promise.resolve([...older].map(([id, status]) => ({ shipId: id, status }))),
      stop: (id: ShipId) => {
        older.delete(id);
        return Promise.resolve();
      },
    };
    const runtime = aRuntime({ beside });

    await expect(runtime.list()).resolves.toEqual([{ shipId, status: 'running', isOtherVersion: true }]);

    await runtime.start({ shipId, folder, command: [...FAKE_CLAUDE_CODE], harness: 'claude-code' });

    expect(older.size).toBe(0);
    await expect(runtime.list()).resolves.toEqual([{ shipId, status: 'running' }]);
  });

  it("refuses a call to the hold's socket from the session's own processes: only the trierarch talks to a hold (H9)", async () => {
    const runtime = aRuntime();
    const shipId = newId('ship');
    const socket = join(sessions, shipId, 'hold.sock');
    const calls = "const net = require('node:net'); setTimeout(() => { const c = net.connect(process.argv[1]); c.on('connect', () => c.write(JSON.stringify({ call: 'send', line: 'from the session' }) + '\\n')); let answer = ''; c.on('data', (d) => { answer += d; }); c.on('close', () => { require('node:fs').writeFileSync('answer.txt', answer); }); }, 500); setInterval(() => undefined, 1000);";

    await runtime.start({ shipId, folder, command: [process.execPath, '-e', calls, socket], harness: 'claude-code' });

    await expect.poll(() => (existsSync(join(folder, 'answer.txt')) ? readFileSync(join(folder, 'answer.txt'), 'utf8') : undefined)).toContain('refused');
    expect(await runtime.events(shipId)).toEqual([]);
  });

  it("refuses a call to a hold's socket from a process another ship's session forked once it is reparented (#196)", { timeout: 20_000 }, async () => {
    const runtime = aRuntime();
    const scout = await aClaudeCodeSession(runtime);
    const socket = join(sessions, scout, 'hold.sock');
    const calls = "const net = require('node:net'); setTimeout(() => { const c = net.connect(process.argv[1]); c.on('connect', () => c.write(JSON.stringify({ call: 'send', line: 'from another session' }) + '\\n')); let answer = ''; c.on('data', (d) => { answer += d; }); c.on('close', () => { require('node:fs').writeFileSync('answer.txt', answer); }); }, 300);";

    // The subshell ends at once, so the process it forked calls once its parent is gone.
    await runtime.start({ shipId: newId('ship'), folder, command: ['sh', '-c', '( "$0" -e "$1" "$2" & ); sleep 30', process.execPath, calls, socket], harness: 'claude-code' });

    await expect.poll(() => (existsSync(join(folder, 'answer.txt')) ? readFileSync(join(folder, 'answer.txt'), 'utf8') : undefined)).toContain('refused');
  });

  it.each(['codex', 'copilot'])("refuses a call to a hold's socket from a process a %s turn of another ship's session forked once that turn has ended and it is reparented (#208)", { timeout: 20_000 }, async (harness) => {
    const runtime = aRuntime();
    const scout = await aClaudeCodeSession(runtime);
    const socket = join(sessions, scout, 'hold.sock');
    const calls = "const net = require('node:net'); setTimeout(() => { const c = net.connect(process.argv[1]); c.on('connect', () => c.write(JSON.stringify({ call: 'send', line: 'from an ended turn' }) + '\\n')); let answer = ''; c.on('data', (d) => { answer += d; }); c.on('close', () => { require('node:fs').writeFileSync('answer.txt', answer); }); }, 1000);";

    // The turn's process ends at once and the hold stays for the next turn; the process it forked calls once the turn is gone.
    await runtime.start({ shipId: newId('ship'), folder, command: ['sh', '-c', '( "$0" -e "$1" "$2" </dev/null >/dev/null 2>&1 & )', process.execPath, calls, socket], harness });

    await expect.poll(() => (existsSync(join(folder, 'answer.txt')) ? readFileSync(join(folder, 'answer.txt'), 'utf8') : undefined), { timeout: 10_000 }).toContain('refused');
  });

  it("answers a process that left another ship's session by its own setsid once it is reparented: no refusal list tells it from the trierarch, and a container is the isolation against it (#196, #174)", { timeout: 20_000 }, async () => {
    const runtime = aRuntime();
    const scout = await aClaudeCodeSession(runtime);
    const socket = join(sessions, scout, 'hold.sock');
    const calls = "const net = require('node:net'); setTimeout(() => { const c = net.connect(process.argv[1]); c.on('connect', () => c.write(JSON.stringify({ call: 'send', line: 'from a process that left its session' }) + '\\n')); let answer = ''; c.on('data', (d) => { answer += d; }); c.on('close', () => { require('node:fs').writeFileSync('answer.txt', answer); }); }, 300);";

    // perl's setsid, as macOS has no setsid command; the subshell ends at once, so the process calls once its parent is gone.
    await runtime.start({ shipId: newId('ship'), folder, command: ['sh', '-c', '( perl -MPOSIX -e \'POSIX::setsid(); exec @ARGV\' "$0" -e "$1" "$2" & ); sleep 30', process.execPath, calls, socket], harness: 'claude-code' });

    await expect.poll(() => (existsSync(join(folder, 'answer.txt')) ? readFileSync(join(folder, 'answer.txt'), 'utf8') : undefined)).toContain('"isOk":true');
  });

  it("takes the hold as the session's root, so the fleet socket answers the harness's processes as its ship's own and no other ship's", async () => {
    const runtime = aRuntime();
    const shipId = newId('ship');
    const path = join(folder, 'fleet.sock');
    const connections: Socket[] = [];
    const server = createServer((connection) => connections.push(connection));
    await new Promise<void>((resolve) => server.listen(path, resolve));
    try {
      const connects = "require('node:net').connect(process.argv[1]); setInterval(() => undefined, 1000);";
      await runtime.start({ shipId, folder, command: ['sh', '-c', `"$0" -e "$1" "$2"; sleep 30`, process.execPath, connects, path], harness: 'claude-code' });
      await expect.poll(() => connections.length).toBe(1);
      const mayCall = createCallerCheck({ platform: process.platform, sessionRootOf: (id) => runtime.sessionRootOf(id) });

      const [connection] = connections;
      if (connection === undefined) {
        throw new Error('the harness never connected');
      }
      await expect(mayCall(shipId, connection)).resolves.toBe(true);
      await expect(mayCall(newId('ship'), connection)).resolves.toBe(false);
    } finally {
      connections.forEach((connection) => connection.destroy());
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('does not signal an unrelated process named by a stale hold PID file', async () => {
    const child = spawn('sleep', ['30']);
    try {
      const runtime = aRuntime();
      const shipId = newId('ship');
      const holdFolder = join(sessions, shipId);
      mkdirSync(holdFolder, { recursive: true });
      writeFileSync(join(holdFolder, 'hold.pid'), String(child.pid));

      await runtime.stop(shipId);

      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(() => process.kill(child.pid ?? 0, 0)).not.toThrow();
    } finally {
      child.kill();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once('exit', () => { resolve(); });
      });
    }
  });

  it('stops a session: its hold and harness end, and it is listed no more', async () => {
    const runtime = aRuntime();
    const shipId = await aClaudeCodeSession(runtime);
    const hold = await runtime.sessionRootOf(shipId);

    await runtime.stop(shipId);

    await expect(runtime.list()).resolves.toEqual([]);
    expect(() => process.kill(hold ?? 0, 0)).toThrow();
  });
});

describe('a Codex session held by a hold, one codex exec per turn (headless H11, H12)', () => {
  const startOf = z.object({ args: z.array(z.string()), pid: z.number() });
  const hookOf = z.looseObject({ event: z.string() });
  const lifeOf = z.object({ pid: z.number(), at: z.enum(['start', 'exit']) });
  const codexStarts = () => written('fake-starts.jsonl').map((start) => startOf.parse(start));
  const hooks = () => written('fake-hooks.jsonl').map((hook) => hookOf.parse(hook).event);
  const lives = () => written('fake-lives.jsonl').map((life) => lifeOf.parse(life));
  const isRunning = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  /** A Codex session whose first turn ran the prompt given, ended. */
  async function aCodexSession(runtime: SessionRuntime, at: { flags?: readonly string[]; prompt?: string } = {}): Promise<ShipId> {
    const shipId = newId('ship');
    await runtime.start({ shipId, folder, command: [...FAKE_CODEX, 'exec', ...(at.flags ?? []), '--json', '--', at.prompt ?? '$aeolus-fleet-wake'], harness: 'codex' });
    return shipId;
  }

  it("starts one codex exec resume of the session's thread for a line it is sent, which ends with Stop (H11)", async () => {
    const runtime = aRuntime();
    const shipId = await aCodexSession(runtime);
    await expect.poll(hooks).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop']);
    await expect.poll(async () => eventsOfType({ runtime, shipId }, 'thread.started')).toHaveLength(1);
    const [thread] = await eventsOfType({ runtime, shipId }, 'thread.started');

    await runtime.send({ shipId, line: 'the hand-over' });

    await expect.poll(hooks).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionStart', 'UserPromptSubmit', 'Stop']);
    const args = codexStarts().map((start) => start.args);
    expect(args).toHaveLength(2);
    expect(args[1]).toEqual(['exec', 'resume', thread?.thread_id, '--json', '--', 'the hand-over']);
    await expect.poll(async () => eventsOfType({ runtime, shipId }, 'turn.completed')).toHaveLength(2);
  });

  it('runs no Codex process between turns, and the hold stays: the session is listed running (H11)', async () => {
    const runtime = aRuntime();
    const shipId = await aCodexSession(runtime);
    await expect.poll(async () => eventsOfType({ runtime, shipId }, 'turn.completed')).toHaveLength(1);

    await expect.poll(() => codexStarts().filter((start) => isRunning(start.pid))).toEqual([]);
    await expect(runtime.list()).resolves.toEqual([{ shipId, status: 'running' }]);
    expect(isRunning((await runtime.sessionRootOf(shipId)) ?? 0)).toBe(true);
  });

  it("gives codex exec no stdin to wait on, so a turn never waits for input that does not come", async () => {
    const runtime = aRuntime();
    const shipId = await aCodexSession(runtime);

    await expect.poll(async () => eventsOfType({ runtime, shipId }, 'turn.completed')).toHaveLength(1);
  });

  /** Longer than a hold call other than interrupt may take, as Codex may take to end after its Stop. */
  const LINGER_MS = 2500;

  it("starts a line's turn only once the last turn's process has ended, never two at once on one thread", async () => {
    const runtime = aRuntime();
    const shipId = await aCodexSession(runtime, { flags: ['--linger-ms', String(LINGER_MS)] });
    await expect.poll(hooks).toContain('Stop');

    await runtime.send({ shipId, line: 'the next one' });

    await expect.poll(lives, { timeout: LINGER_MS * 2 }).toHaveLength(4);
    expect(lives().map((life) => life.at)).toEqual(['start', 'exit', 'start', 'exit']);
  }, LINGER_MS * 4);

  it('starts one turn at a time when two lines arrive together while a turn runs, never two at once on one thread', async () => {
    const runtime = aRuntime();
    const shipId = await aCodexSession(runtime, { flags: ['--linger-ms', String(LINGER_MS)] });
    await expect.poll(hooks).toContain('Stop');

    await Promise.all([runtime.send({ shipId, line: 'the first one' }), runtime.send({ shipId, line: 'the second one' })]);

    await expect.poll(lives, { timeout: LINGER_MS * 4 }).toHaveLength(6);
    expect(lives().map((life) => life.at)).toEqual(['start', 'exit', 'start', 'exit', 'start', 'exit']);
  }, LINGER_MS * 6);

  it('stops a running turn with SIGINT and waits for its process to end; the forced line runs next, resuming the thread (H12)', async () => {
    const runtime = aRuntime();
    const shipId = await aCodexSession(runtime);
    await expect.poll(hooks).toContain('Stop');
    await runtime.send({ shipId, line: 'work slowly' });
    await expect.poll(async () => eventsOfType({ runtime, shipId }, 'item.completed')).toHaveLength(2);

    await runtime.interrupt(shipId);

    expect(hooks().slice(-1)).toEqual(['Interrupt']);
    expect(codexStarts().filter((start) => isRunning(start.pid))).toEqual([]);
    await runtime.send({ shipId, line: 'the forced one' });
    await expect.poll(hooks).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionStart', 'UserPromptSubmit', 'Interrupt', 'SessionStart', 'UserPromptSubmit', 'Stop']);
    expect(codexStarts().at(-1)?.args.slice(-2)).toEqual(['--', 'the forced one']);
    await expect(runtime.list()).resolves.toEqual([{ shipId, status: 'running' }]);
  });

  it('interrupts nothing between turns: no process runs to stop', async () => {
    const runtime = aRuntime();
    const shipId = await aCodexSession(runtime);
    await expect.poll(hooks).toContain('Stop');

    await runtime.interrupt(shipId);

    expect(hooks()).not.toContain('Interrupt');
    expect(codexStarts()).toHaveLength(1);
  });

  it('resumes no thread when thread.started names none: a line is refused until Codex names one', async () => {
    const runtime = aRuntime();
    const shipId = await aCodexSession(runtime, { flags: ['--thread-id', ''] });
    await expect.poll(hooks).toContain('Stop');

    await expect(runtime.send({ shipId, line: 'the hand-over' })).rejects.toThrow('Codex named no thread to resume yet');
    expect(codexStarts()).toHaveLength(1);
  });

  it('resumes the thread thread.started names, not one another event names', async () => {
    const runtime = aRuntime();
    const shipId = await aCodexSession(runtime, { flags: ['--thread-id', 'thread-1', '--stray-thread-id', 'not-a-thread'] });
    await expect.poll(hooks).toContain('Stop');

    await runtime.send({ shipId, line: 'the hand-over' });

    await expect.poll(() => codexStarts()).toHaveLength(2);
    expect(codexStarts()[1]?.args.slice(0, 3)).toEqual(['exec', 'resume', 'thread-1']);
  });

  it("keeps the hold and the failed turn's error event when the turn fails, so the launch window reads why (H13)", async () => {
    const runtime = aRuntime();
    const shipId = await aCodexSession(runtime, { flags: ['--refuse-model'] });

    await expect.poll(async () => eventsOfType({ runtime, shipId }, 'turn.failed')).toHaveLength(1);
    await expect(runtime.list()).resolves.toEqual([{ shipId, status: 'running' }]);
  });

  it('stops a session mid-turn: its hold and the running codex exec end', async () => {
    const runtime = aRuntime();
    const shipId = await aCodexSession(runtime, { prompt: 'work slowly' });
    await expect.poll(async () => eventsOfType({ runtime, shipId }, 'item.completed')).toHaveLength(1);
    const [turn] = codexStarts();

    await runtime.stop(shipId);

    await expect(runtime.list()).resolves.toEqual([]);
    await expect.poll(() => isRunning(turn?.pid ?? 0)).toBe(false);
  });

  it('stops a session between turns: its hold ends', async () => {
    const runtime = aRuntime();
    const shipId = await aCodexSession(runtime);
    await expect.poll(hooks).toContain('Stop');
    const hold = await runtime.sessionRootOf(shipId);

    await runtime.stop(shipId);

    await expect(runtime.list()).resolves.toEqual([]);
    expect(isRunning(hold ?? 0)).toBe(false);
  });
});

describe('a Copilot session held by a hold, one copilot -p per turn (CC4)', () => {
  const startOf = z.object({ args: z.array(z.string()), pid: z.number() });
  const hookOf = z.looseObject({ event: z.string() });
  const lifeOf = z.object({ pid: z.number(), at: z.enum(['start', 'exit']) });
  const copilotStarts = () => written('fake-starts.jsonl').map((start) => startOf.parse(start));
  const hooks = () => written('fake-hooks.jsonl').map((hook) => hookOf.parse(hook).event);
  const lives = () => written('fake-lives.jsonl').map((life) => lifeOf.parse(life));
  const resultOf = z.looseObject({ sessionId: z.string() });

  /** A Copilot session whose first turn ran the prompt given. */
  async function aCopilotSession(runtime: SessionRuntime, at: { flags?: readonly string[]; prompt?: string } = {}): Promise<ShipId> {
    const shipId = newId('ship');
    await runtime.start({ shipId, folder, command: [...FAKE_COPILOT, ...(at.flags ?? []), '--output-format=json', '--allow-all-tools', '--no-ask-user', `--prompt=${at.prompt ?? 'wake'}`], harness: 'copilot' });
    return shipId;
  }

  it("starts one copilot -p resuming the session the last turn's result named for a line it is sent, the line its prompt", async () => {
    const runtime = aRuntime();
    const shipId = await aCopilotSession(runtime);
    await expect.poll(async () => eventsOfType({ runtime, shipId }, 'result')).toHaveLength(1);
    const [result] = await eventsOfType({ runtime, shipId }, 'result');

    await runtime.send({ shipId, line: 'the hand-over' });

    await expect.poll(async () => eventsOfType({ runtime, shipId }, 'result')).toHaveLength(2);
    expect(copilotStarts()[1]?.args).toEqual(['--output-format=json', '--allow-all-tools', '--no-ask-user', `--resume=${resultOf.parse(result).sessionId}`, '--prompt=the hand-over']);
  });

  it('runs no Copilot process between turns, and the hold stays: the session is listed running', async () => {
    const runtime = aRuntime();
    const shipId = await aCopilotSession(runtime);
    await expect.poll(async () => eventsOfType({ runtime, shipId }, 'result')).toHaveLength(1);

    await expect.poll(() => lives().map((life) => life.at)).toEqual(['start', 'exit']);
    await expect(runtime.list()).resolves.toEqual([{ shipId, status: 'running' }]);
  });

  it("stops a running turn with SIGINT to Copilot's native process too, never its launcher alone, and starts the forced line's turn only once the native process ended", async () => {
    const runtime = aRuntime();
    const shipId = await aCopilotSession(runtime);
    await expect.poll(async () => eventsOfType({ runtime, shipId }, 'result')).toHaveLength(1);
    await runtime.send({ shipId, line: 'work slowly' });
    await expect.poll(async () => eventsOfType({ runtime, shipId }, 'assistant.message')).toHaveLength(2);

    await runtime.interrupt(shipId);
    await runtime.send({ shipId, line: 'the forced one' });

    await expect.poll(async () => eventsOfType({ runtime, shipId }, 'result')).toHaveLength(3);
    expect(lives().map((life) => life.at)).toEqual(['start', 'exit', 'start', 'exit', 'start', 'exit']);
    expect(hooks()).toEqual(['SessionStart', 'Stop', 'SessionEnd', 'SessionStart', 'SessionEnd', 'SessionStart', 'Stop', 'SessionEnd']);
    await expect(runtime.list()).resolves.toEqual([{ shipId, status: 'running' }]);
  });

  it('interrupts nothing between turns: no process runs to stop', async () => {
    const runtime = aRuntime();
    const shipId = await aCopilotSession(runtime);
    await expect.poll(async () => eventsOfType({ runtime, shipId }, 'result')).toHaveLength(1);

    await runtime.interrupt(shipId);

    expect(copilotStarts()).toHaveLength(1);
    await expect(runtime.list()).resolves.toEqual([{ shipId, status: 'running' }]);
  });

  it("ends its hold when a turn fails, keeping the turn's session error, so the session restarts and its launch window reads why", async () => {
    const runtime = aRuntime();
    const shipId = await aCopilotSession(runtime, { flags: ['--fail-model-call'] });

    await expect.poll(async () => runtime.list()).toEqual([expect.objectContaining({ shipId, status: 'exited' })]);
    await expect(eventsOfType({ runtime, shipId }, 'session.error')).resolves.toHaveLength(1);
  });

  it('keeps what Copilot writes on stderr among the events, as it says a refused model before any event, and ends its hold', async () => {
    const runtime = aRuntime();
    const shipId = await aCopilotSession(runtime, { flags: ['--refuse-model'] });

    await expect.poll(async () => runtime.list()).toEqual([expect.objectContaining({ shipId, status: 'exited' })]);
    await expect(eventsOfType({ runtime, shipId }, 'aeolus.stderr')).resolves.toEqual([{ type: 'aeolus.stderr', line: 'Error: Model "no-such-model" from --model flag is not available.' }]);
  });

  it('stops a session mid-turn: its hold and the running native process end', async () => {
    const runtime = aRuntime();
    const shipId = await aCopilotSession(runtime, { prompt: 'work slowly' });
    await expect.poll(async () => eventsOfType({ runtime, shipId }, 'assistant.message')).toHaveLength(1);
    const [turn] = copilotStarts();

    await runtime.stop(shipId);

    await expect(runtime.list()).resolves.toEqual([]);
    await expect.poll(() => isAlive(turn?.pid ?? 0)).toBe(false);
  });
});

describe('a starting hold', () => {
  it('waits for the socket when the PID file exists before its PID is written', async () => {
    const delayed = `const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const args = process.argv;
const folder = path.join(args[args.indexOf('--sessions') + 1], args[2]);
fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(folder, 'hold.pid'), '');
setTimeout(() => {
  fs.writeFileSync(path.join(folder, 'hold.pid'), String(process.pid));
  net.createServer((connection) => {
    connection.on('data', () => connection.end(JSON.stringify({ isOk: true, state: { status: 'running', version: '${VERSION}' } }) + '\\n'));
  }).listen(path.join(folder, 'hold.sock'));
}, 500);`;
    const runtime = aRuntime({ program: [process.execPath, '-e', delayed] });
    const shipId = newId('ship');

    await runtime.start({ shipId, folder, command: [...FAKE_CLAUDE_CODE], harness: 'claude-code' });

    await expect(runtime.send({ shipId, line: userLine('hello') })).resolves.toBeUndefined();
  });
});

describe('why a hold does not start', () => {
  it("says what the starter wrote when it fails, such as systemd-run's own refusal of an option", async () => {
    const runtime = aRuntime({ launch: ['sh', '-c', 'echo "systemd-run: unrecognized option --expand-environment=no" >&2; exit 1', 'sh'] });

    await expect(runtime.start({ shipId: newId('ship'), folder, command: [...FAKE_CLAUDE_CODE], harness: 'claude-code' })).rejects.toThrow(/unrecognized option --expand-environment=no/);
  });

  it('names ss and iproute2 when the hold answers every call of the trierarch with a refusal, as it does where ss is missing', { timeout: 20_000 }, async () => {
    const pidFile = join(folder, 'refusing.pid');
    const refusing = `const net = require('node:net'); const a = process.argv; const socket = a[a.indexOf('--sessions') + 1] + '/' + a[2] + '/hold.sock'; require('node:fs').mkdirSync(require('node:path').dirname(socket), { recursive: true }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); require('node:fs').writeFileSync(require('node:path').join(require('node:path').dirname(socket), 'hold.pid'), String(process.pid)); net.createServer((c) => { c.on('error', () => undefined); c.end(JSON.stringify({ isOk: false, error: 'refused: only the trierarch talks to a hold' }) + '\\n'); }).listen(socket);`;
    const runtime = aRuntime({ program: [process.execPath, '-e', refusing] });
    const shipId = newId('ship');

    try {
      await expect(runtime.start({ shipId, folder, command: [...FAKE_CLAUDE_CODE], harness: 'claude-code' })).rejects.toThrow(/refused.*iproute2/s);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      await runtime.stop(shipId);
      await expect.poll(() => isAlive(pid), { timeout: 1_000 }).toBe(false);
    } finally {
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, 'utf8'));
        if (isAlive(pid)) process.kill(pid, 'SIGTERM');
      }
    }
  });
});

describe('where a hold starts (#537)', () => {
  it("starts through a systemd scope of its own under a systemd unit, so the service's restart ends no session, and leaves every $ in the command as it is (systemd 259 turns $$ into $)", () => {
    expect(sessionsLaunch({ platform: 'linux', env: { INVOCATION_ID: 'c0ffee' }, systemdVersion: 255 })).toEqual(['systemd-run', '--user', '--scope', '--quiet', '--collect', '--expand-environment=no', '--']);
  });

  it('leaves --expand-environment out where systemd-run has none: before systemd 254, which Debian 12 (252) and Ubuntu 22.04 (249) run', () => {
    expect(sessionsLaunch({ platform: 'linux', env: { INVOCATION_ID: 'c0ffee' }, systemdVersion: 252 })).toEqual(['systemd-run', '--user', '--scope', '--quiet', '--collect', '--']);
    expect(sessionsLaunch({ platform: 'linux', env: { INVOCATION_ID: 'c0ffee' }, systemdVersion: 249 })).toEqual(['systemd-run', '--user', '--scope', '--quiet', '--collect', '--']);
  });

  it('passes --expand-environment=no from systemd 254, where systemd-run has it', () => {
    expect(sessionsLaunch({ platform: 'linux', env: { INVOCATION_ID: 'c0ffee' }, systemdVersion: 254 })).toContain('--expand-environment=no');
    expect(sessionsLaunch({ platform: 'linux', env: { INVOCATION_ID: 'c0ffee' }, systemdVersion: 259 })).toContain('--expand-environment=no');
  });

  it('starts itself on Linux outside a systemd unit', () => {
    expect(sessionsLaunch({ platform: 'linux', env: {} })).toEqual([]);
  });

  it('starts itself on macOS, where launchd leaves the sessions running', () => {
    expect(sessionsLaunch({ platform: 'darwin', env: { INVOCATION_ID: 'c0ffee' } })).toEqual([]);
  });
});

describe('the systemd version systemd-run states', () => {
  const stating = (stdout: string): typeof runCommand => () => Promise.resolve({ status: 0, stdout, stderr: '' });

  it('is the number after systemd', async () => {
    await expect(systemdVersionOf(stating('systemd 252 (252.31-1~deb12u1)\n+PAM +AUDIT\n'))).resolves.toBe(252);
  });

  it('is none when systemd-run states nothing a version is read from', async () => {
    await expect(systemdVersionOf(stating(''))).resolves.toBeUndefined();
    await expect(systemdVersionOf(() => Promise.reject(new Error('spawn systemd-run ENOENT')))).resolves.toBeUndefined();
  });
});
