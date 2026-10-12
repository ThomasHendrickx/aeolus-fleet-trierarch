import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { readLogLine } from '../../../packages/trierarch/src/adapters/log.js';
import { startStubFleet, type StubFleet } from './stub-fleet.js';
import { scriptEnvironment } from './script-environment.js';

// The aeolus plugin's bash scripts, as a session runs them: in its folder,
// with the plugin's data folder, against a stub of the fleet's REST door.

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));
const CREW_TOKEN = 'aeolus_ct_v1_crew';
const SHIP_ID = 'shp_01m3tbfspe96yf1rnr4ank9h1a';

let data: string;
let folder: string;
/** A throwaway home: the identities live under it, never in the real one. */
let home: string;
let fleet: StubFleet | undefined;

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'aeolus-data-'));
  home = mkdtempSync(join(tmpdir(), 'aeolus-home-'));
  folder = mkdtempSync(join(tmpdir(), 'aeolus folder "one"-'));
});

afterEach(async () => {
  if (statSync(identityFile(), { throwIfNoEntry: false })) {
    run('aeolus-identity.sh', { args: ['delete'] });
  }
  await fleet?.close();
  fleet = undefined;
  rmSync(data, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
});

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a script as a session's command does: the hook has exported the folder and the data folder. */
function run(script: string, options: { args?: string[]; env?: Record<string, string>; stdin?: string } = {}): Run {
  const result = spawnSync('bash', [join(SCRIPTS, script), ...(options.args ?? [])], {
    input: options.stdin ?? '',
    encoding: 'utf8',
    env: scriptEnvironment({ HOME: home, AEOLUS_FOLDER: folder, AEOLUS_DATA: data, AEOLUS_RETRY_SECONDS: '0', AEOLUS_POLL_SECONDS: '0.05', ...options.env }),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Runs a script without waiting for it, for one that keeps running. */
function start(script: string, options: { args?: string[]; env?: Record<string, string>; stdin?: string } = {}) {
  const child = spawn('bash', [join(SCRIPTS, script), ...(options.args ?? [])], {
    env: scriptEnvironment({ HOME: home, AEOLUS_FOLDER: folder, AEOLUS_DATA: data, AEOLUS_RETRY_SECONDS: '0', AEOLUS_POLL_SECONDS: '0.05', ...options.env }),
  });
  child.stdin.end(options.stdin ?? '');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const exited = new Promise<{ status: number | null; stdout: string }>((resolve) => {
    child.on('exit', (status) => {
      resolve({ status, stdout });
    });
  });
  /** Once its output is all read too: with what it printed on stderr. */
  const done = new Promise<Run>((resolve) => {
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
  return { child, exited, done };
}

/** What a Codex skill's commands set: each harness keeps its sessions' identities in a crews folder of its own (#658). */
const AS_CODEX = { AEOLUS_HARNESS: 'codex' };

function crew(fleetUrl = 'https://fleet.example.com', env: Record<string, string> = {}): void {
  expect(run('aeolus-identity.sh', { args: ['write', fleetUrl, SHIP_ID, 'scout', CREW_TOKEN], env }).status).toBe(0);
}

function identityFile(env: Record<string, string> = {}): string {
  return run('aeolus-identity.sh', { args: ['path'], env }).stdout.trim();
}

function pidFile(): string {
  return identityFile().replace(/\.identity$/, '.watch.pid');
}

function wakePidFile(env: Record<string, string> = {}): string {
  return identityFile(env).replace(/\.identity$/, '.wake.pid');
}

function wakeThreadFile(): string {
  return identityFile().replace(/\.identity$/, '.wake.thread');
}

const inbox = (waiting: number) => ({ status: 200, body: { waiting } });

/** The session took a prompt: its turn is busy. */
function aPromptSubmitted(): void {
  expect(claudeHook('aeolus-turn.sh', { hook_event_name: 'UserPromptSubmit', prompt: 'hello' }).status).toBe(0);
}

/** The session ended its turn: it is idle. */
function aTurnEnded(): void {
  expect(claudeHook('aeolus-stop.sh', { hook_event_name: 'Stop', stop_hook_active: true }).status).toBe(0);
}

/** The turn marker, through the plugin's own script. */
function turn(env: Record<string, string> = {}): Run {
  return run('aeolus-identity.sh', { args: ['turn'], env });
}

/** The plugin's log, each line read by the trierarch's own log reader, as aeolus-trierarch logs reads its log. */
function logged() {
  const file = join(data, 'logs', 'aeolus.log');
  if (!statSync(file, { throwIfNoEntry: false })) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => readLogLine(line));
}

/** What each record of the plugin's log says, without when. */
function actions() {
  return logged().map((record) => ('time' in record ? { ...record, time: undefined } : record));
}

const scout = { time: undefined, shipId: SHIP_ID, shipName: 'scout' };

describe('aeolus-identity', () => {
  it("writes the folder's ship and shows it, never the crew token", () => {
    crew();

    const shown = run('aeolus-identity.sh', { args: ['show'] });

    expect(shown.status).toBe(0);
    expect(shown.stdout).toContain(`ship: scout (${SHIP_ID})`);
    expect(shown.stdout).toContain('fleet: https://fleet.example.com');
    expect(shown.stdout).toContain(`folder: ${realpathSync(folder)}`);
    expect(shown.stdout).not.toContain(CREW_TOKEN);
    expect(readFileSync(identityFile(), 'utf8')).toContain(`crewToken=${CREW_TOKEN}\n`);
  });

  it('keeps the squadron a member ship belongs to, and shows it', () => {
    expect(run('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', SHIP_ID, 'tester-k3x9', CREW_TOKEN, 'team-one'] }).status).toBe(0);

    expect(readFileSync(identityFile(), 'utf8')).toContain('squadron=team-one\n');
    expect(run('aeolus-identity.sh', { args: ['show'] }).stdout).toContain('squadron: team-one');
  });

  it('keeps the file readable by its owner only', () => {
    crew();

    expect(statSync(identityFile()).mode & 0o777).toBe(0o600);
  });

  it('keys each folder apart: two folders crew two ships', () => {
    crew();
    const other = mkdtempSync(join(tmpdir(), 'aeolus-other-'));
    try {
      run('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', SHIP_ID, 'lookout', 'aeolus_ct_v1_other'], env: { AEOLUS_FOLDER: other } });

      expect(run('aeolus-identity.sh', { args: ['show'] }).stdout).toContain('ship: scout');
      expect(run('aeolus-identity.sh', { args: ['show'], env: { AEOLUS_FOLDER: other } }).stdout).toContain('ship: lookout');
      expect(readdirSync(join(home, '.aeolus', 'crews', 'claude-code'))).toHaveLength(2);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('uses the physical folder path so a symlink and its target keep one identity', () => {
    const linked = `${folder}-linked`;
    symlinkSync(folder, linked);
    try {
      expect(
        run('aeolus-identity.sh', {
          args: ['write', 'https://fleet.example.com', SHIP_ID, 'scout', CREW_TOKEN],
          env: { AEOLUS_FOLDER: linked },
        }).status,
      ).toBe(0);

      expect(run('aeolus-identity.sh', { args: ['show'] }).stdout).toContain('ship: scout');
    } finally {
      rmSync(linked);
    }
  });

  it('shows nothing, and fails, for a folder that crews no ship', () => {
    expect(run('aeolus-identity.sh', { args: ['show'] })).toMatchObject({ status: 1, stdout: 'aeolus: this folder crews no ship\n' });
  });

  it('forgets the ship without killing unrelated processes named by stale pid files', async () => {
    crew();
    const sleeper = spawn('sleep', ['30']);
    const wakeSleeper = spawn('sleep', ['30']);
    writeFileSync(pidFile(), `${String(sleeper.pid)}\n`);
    writeFileSync(wakePidFile(), `${String(wakeSleeper.pid)}\n`);
    try {
      expect(run('aeolus-identity.sh', { args: ['delete'] }).status).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(sleeper.exitCode).toBeNull();
      expect(wakeSleeper.exitCode).toBeNull();
      expect(readdirSync(join(home, '.aeolus', 'crews', 'claude-code'))).toEqual([]);
    } finally {
      sleeper.kill();
      wakeSleeper.kill();
    }
  });
});

describe('aeolus-watch-status', () => {
  it('says not watching without a watcher', () => {
    expect(run('aeolus-watch-status.sh')).toMatchObject({ status: 1, stdout: 'aeolus: not watching\n' });
  });

  it('says watching while an aeolus watcher process holds the lock', () => {
    crew();
    const bin = join(data, 'bin');
    mkdirSync(bin);
    const watcher = join(bin, 'aeolus-wait.sh');
    writeFileSync(watcher, '#!/usr/bin/env bash\nsleep 30\n');
    chmodSync(watcher, 0o700);
    const process = spawn('bash', [watcher]);
    writeFileSync(pidFile(), `${String(process.pid)}\n`);

    try {
      expect(run('aeolus-watch-status.sh')).toMatchObject({ status: 0, stdout: 'aeolus: watching\n' });
    } finally {
      process.kill();
    }
  });

  it('says not watching when the lock names a process that ended', () => {
    crew();
    const ended = spawnSync('bash', ['-c', 'echo $$']).stdout.toString().trim();
    writeFileSync(pidFile(), `${ended}\n`);

    expect(run('aeolus-watch-status.sh').status).toBe(1);
  });
});

describe('aeolus-status: the version, the ship, its fleet and folder, what wakes it, the lease and the inbox, answered by the script', () => {
  const version = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(SCRIPTS, '../.claude-plugin/plugin.json'), 'utf8'))).version;
  const whoami = { status: 200, body: { shipId: SHIP_ID, fleetId: 'flt_01m3tbfspe96yf1rnr4ank9h1c', name: 'scout', type: 'implementer' } };

  it('says the version and that this folder crews no ship, and calls no fleet', () => {
    expect(run('aeolus-status.sh')).toMatchObject({
      status: 2,
      stdout: `Version: ${version}\nShip: none: this folder crews no ship; its crew line crews one\n`,
    });
  });

  it('asks whoami and the inbox with the crew token, and says the ship, its fleet and folder, the watcher, the lease and the deliveries waiting', async () => {
    fleet = await startStubFleet([whoami, inbox(2)]);
    crew(fleet.url);

    const { status, stdout } = await start('aeolus-status.sh').exited;

    expect(status).toBe(0);
    expect(stdout).toBe(
      `Version: ${version}\nShip: scout (${SHIP_ID}), type implementer\nFleet: ${fleet.url}\nFolder: ${realpathSync(folder)}\nRunning: no watcher runs\nLease: holds\nInbox: 2 deliveries wait\n`,
    );
    expect(fleet.calls.map((call) => [call.method, call.path, call.authorization])).toEqual([
      ['GET', '/api/v1/ship/whoami', `Bearer ${CREW_TOKEN}`],
      ['POST', '/api/v1/ship/inbox', `Bearer ${CREW_TOKEN}`],
    ]);
    expect(stdout).not.toContain(CREW_TOKEN);
  });

  it('says one delivery waits, and none', async () => {
    fleet = await startStubFleet([whoami, inbox(1), whoami, inbox(0)]);
    crew(fleet.url);

    expect((await start('aeolus-status.sh').exited).stdout).toContain('Inbox: 1 delivery waits\n');
    expect((await start('aeolus-status.sh').exited).stdout).toContain('Inbox: none wait\n');
  });

  it('says the watcher runs while an aeolus watcher process holds the lock', async () => {
    fleet = await startStubFleet([whoami, inbox(0)]);
    crew(fleet.url);
    const bin = join(data, 'bin');
    mkdirSync(bin);
    const watcher = join(bin, 'aeolus-wait.sh');
    writeFileSync(watcher, '#!/usr/bin/env bash\nsleep 30\n');
    chmodSync(watcher, 0o700);
    const process = spawn('bash', [watcher]);
    writeFileSync(pidFile(), `${String(process.pid)}\n`);

    try {
      expect((await start('aeolus-status.sh').exited).stdout).toContain('Running: the watcher runs\n');
    } finally {
      process.kill();
    }
  });

  it('says the trierarch wakes the session when it does, not a watcher', async () => {
    fleet = await startStubFleet([whoami, inbox(0)]);
    expect(run('aeolus-identity.sh', { args: ['write', '--wake-by', 'trierarch', fleet.url, SHIP_ID, 'scout', CREW_TOKEN] }).status).toBe(0);

    expect((await start('aeolus-status.sh').exited).stdout).toContain('Running: the trierarch wakes this session\n');
  });

  it('exits 3 on LEASE_ENDED, says the lease ended and the plugin forgot the ship, and asks no inbox', async () => {
    fleet = await startStubFleet([{ status: 401, body: { code: 'LEASE_ENDED', message: 'This ship was released' } }]);
    crew(fleet.url);

    const { status, stdout } = await start('aeolus-status.sh').exited;

    expect(status).toBe(3);
    expect(stdout).toBe(
      `Version: ${version}\nShip: scout (${SHIP_ID})\nFleet: ${fleet.url}\nFolder: ${realpathSync(folder)}\nRunning: no watcher runs\nLease: ended: the operator released the ship, and the plugin forgot it\nInbox: none: the ship was released\n`,
    );
    expect(fleet.calls).toHaveLength(1);
    expect(statSync(identityFile(), { throwIfNoEntry: false })).toBeUndefined();
  });

  it('exits 6 and says so when the fleet does not answer', async () => {
    crew('http://127.0.0.1:9');

    const { status, stdout } = await start('aeolus-status.sh').exited;

    expect(status).toBe(6);
    expect(stdout).toContain('Lease: unknown: no answer from http://127.0.0.1:9\n');
    expect(stdout).toContain('Inbox: unknown: no answer from the fleet\n');
  });
});

describe('aeolus-wait', () => {
  it("asks the inbox check with the crew token, keeps asking while none wait, and exits 0 once some do", async () => {
    fleet = await startStubFleet([inbox(0), inbox(0), inbox(2)]);
    crew(fleet.url);
    aTurnEnded();

    const { status, stdout } = await start('aeolus-wait.sh').exited;

    expect(status).toBe(0);
    expect(stdout).toBe('aeolus: 2 deliveries wait for scout: receive them\n');
    expect(fleet.calls).toHaveLength(3);
    expect(fleet.calls[0]).toEqual({
      method: 'POST',
      path: '/api/v1/ship/inbox',
      authorization: `Bearer ${CREW_TOKEN}`,
      body: '{"waitSeconds":25}',
    });
  });

  it('holds the lock while it runs and frees it when it exits', async () => {
    // The fleet holds its answer until the test has seen the lock, so the watcher cannot exit before the check.
    let answer: () => void = () => undefined;
    const isLockSeen = new Promise<void>((resolve) => {
      answer = resolve;
    });
    fleet = await startStubFleet([{ ...inbox(1), hold: isLockSeen }]);
    crew(fleet.url);
    aTurnEnded();

    const { exited } = start('aeolus-wait.sh', { env: { AEOLUS_WAIT_SECONDS: '0' } });
    await expect.poll(() => run('aeolus-watch-status.sh').status).toBe(0);
    answer();
    await exited;

    expect(run('aeolus-watch-status.sh').status).toBe(1);
  });

  it('exits 4 and starts no second watcher while one runs for the ship', () => {
    crew();
    const bin = join(data, 'bin');
    mkdirSync(bin);
    const watcher = join(bin, 'aeolus-wait.sh');
    writeFileSync(watcher, '#!/usr/bin/env bash\nsleep 30\n');
    chmodSync(watcher, 0o700);
    const process = spawn('bash', [watcher]);
    writeFileSync(pidFile(), `${String(process.pid)}\n`);

    try {
      expect(run('aeolus-wait.sh')).toMatchObject({
        status: 4,
        stdout: 'aeolus: already watching: a watcher runs for this ship; do not start another\n',
      });
      expect(readFileSync(pidFile(), 'utf8')).toBe(`${String(process.pid)}\n`);
    } finally {
      process.kill();
    }
  });

  it('exits 3 on LEASE_ENDED: the operator released the ship', async () => {
    fleet = await startStubFleet([{ status: 401, body: { code: 'LEASE_ENDED', message: 'This ship was released' } }]);
    crew(fleet.url);

    await expect(start('aeolus-wait.sh').exited).resolves.toEqual({
      status: 3,
      stdout: 'aeolus: LEASE_ENDED: the operator released scout; this session no longer crews it, and the plugin forgot it\n',
    });
  });

  it('forgets the ship on LEASE_ENDED with the crew token the identity file still holds', async () => {
    fleet = await startStubFleet([{ status: 401, body: { code: 'LEASE_ENDED', message: 'This ship was released' } }]);
    crew(fleet.url);

    const { stdout } = await start('aeolus-wait.sh').exited;

    expect(stdout).toContain('the plugin forgot it');
    expect(statSync(identityFile(), { throwIfNoEntry: false })).toBeUndefined();
  });

  it('keeps the identity file, and watches on with its crew token, when the folder was crewed again while it watched', async () => {
    let answerLeaseEnded = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      answerLeaseEnded = resolve;
    });
    fleet = await startStubFleet([
      { status: 401, body: { code: 'LEASE_ENDED', message: 'This ship was released' }, hold: held },
      inbox(1),
    ]);
    const stub = fleet;
    crew(stub.url);
    aTurnEnded();
    const watcher = start('aeolus-wait.sh');
    await expect.poll(() => stub.calls.length).toBe(1);
    expect(run('aeolus-identity.sh', { args: ['write', stub.url, SHIP_ID, 'scout', 'aeolus_ct_v1_new_crew'] }).status).toBe(0);
    answerLeaseEnded();

    await expect(watcher.exited).resolves.toEqual({ status: 0, stdout: 'aeolus: 1 deliveries wait for scout: receive them\n' });
    expect(stub.calls[1]?.authorization).toBe('Bearer aeolus_ct_v1_new_crew');
    expect(readFileSync(identityFile(), 'utf8')).toContain('crewToken=aeolus_ct_v1_new_crew\n');
  });

  it('exits 5 when the fleet refuses the crew token', async () => {
    fleet = await startStubFleet([{ status: 401, body: { code: 'UNAUTHORIZED', message: 'Call with the crew token' } }]);
    crew(fleet.url);

    await expect(start('aeolus-wait.sh').exited).resolves.toMatchObject({ status: 5 });
  });

  it('retries a failing fleet quietly, then exits 0 once deliveries wait', async () => {
    fleet = await startStubFleet([{ status: 500, body: {} }, { status: 503, body: {} }, inbox(1)]);
    crew(fleet.url);
    aTurnEnded();

    await expect(start('aeolus-wait.sh').exited).resolves.toEqual({
      status: 0,
      stdout: 'aeolus: 1 deliveries wait for scout: receive them\n',
    });
    expect(fleet.calls).toHaveLength(3);
  });

  it('exits 2 when the folder crews no ship', () => {
    expect(run('aeolus-wait.sh')).toMatchObject({ status: 2 });
  });

  it('exits 6 by itself shortly before the 2 hours a background task may run, so the session starts it again', async () => {
    fleet = await startStubFleet([inbox(0)]);
    crew(fleet.url);

    const { status, stdout } = await start('aeolus-wait.sh', {
      env: { AEOLUS_WAIT_SECONDS: '0', AEOLUS_MAX_SECONDS: '1' },
    }).exited;

    expect(status).toBe(6);
    expect(stdout).toBe(
      'aeolus: watched scout for almost 2 hours, the most a background task runs: start the watcher again\n',
    );
    expect(run('aeolus-watch-status.sh').status).toBe(1);
  });

  it('stops by 1 hour 55 minutes unless told otherwise', () => {
    expect(readFileSync(join(SCRIPTS, 'aeolus-wait.sh'), 'utf8')).toContain('MAX_SECONDS="${AEOLUS_MAX_SECONDS:-6900}"');
  });
});

describe("the watcher's wake rule: one wake per rise in the waiting count, given only when the session is idle", () => {
  it('holds the wake while the session is busy, and gives it once the turn ends', async () => {
    fleet = await startStubFleet([inbox(1)]);
    const stub = fleet;
    crew(stub.url);
    aPromptSubmitted();
    const watcher = start('aeolus-wait.sh');
    let isExited = false;
    void watcher.exited.then(() => {
      isExited = true;
    });

    await expect.poll(() => stub.calls.length).toBeGreaterThanOrEqual(3);
    expect(isExited).toBe(false);
    claudeHook('aeolus-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false });

    await expect(watcher.exited).resolves.toEqual({ status: 0, stdout: 'aeolus: 1 deliveries wait for scout: receive them\n' });
  });

  it('wakes no session that has not ended a turn yet', async () => {
    fleet = await startStubFleet([inbox(1)]);
    const stub = fleet;
    crew(stub.url);
    const watcher = start('aeolus-wait.sh');
    let isExited = false;
    void watcher.exited.then(() => {
      isExited = true;
    });

    try {
      await expect.poll(() => stub.calls.length).toBeGreaterThanOrEqual(3);
      expect(isExited).toBe(false);
    } finally {
      watcher.child.kill();
    }
  });

  it('marks the turn busy when a prompt is submitted, in a folder no trierarch crews', () => {
    crew();

    claudeHook('aeolus-turn.sh', { hook_event_name: 'UserPromptSubmit', prompt: 'hello' });

    expect(turn().stdout).toMatch(/^busy /);
  });

  it('marks the turn busy when it wakes the session', async () => {
    fleet = await startStubFleet([inbox(1)]);
    crew(fleet.url);
    aTurnEnded();

    await start('aeolus-wait.sh').exited;

    expect(turn().stdout).toMatch(/^busy /);
  });

  it('wakes once per rise: started again, it wakes not for the deliveries it already woke for, but for one more', async () => {
    fleet = await startStubFleet([inbox(2), inbox(2), inbox(2), inbox(3)]);
    crew(fleet.url);
    aTurnEnded();
    await start('aeolus-wait.sh').exited;
    aTurnEnded();

    await expect(start('aeolus-wait.sh').exited).resolves.toEqual({ status: 0, stdout: 'aeolus: 3 deliveries wait for scout: receive them\n' });
    expect(fleet.calls).toHaveLength(4);
  });

  it('wakes again once the count rises after the session received what waited', async () => {
    fleet = await startStubFleet([inbox(2), inbox(0), inbox(1)]);
    crew(fleet.url);
    aTurnEnded();
    await start('aeolus-wait.sh').exited;
    aTurnEnded();

    await expect(start('aeolus-wait.sh').exited).resolves.toEqual({ status: 0, stdout: 'aeolus: 1 deliveries wait for scout: receive them\n' });
    expect(fleet.calls).toHaveLength(3);
  });

  it('keeps a wake it held for a busy session when it is started again', async () => {
    fleet = await startStubFleet([inbox(1)]);
    crew(fleet.url);
    aPromptSubmitted();
    await expect(start('aeolus-wait.sh', { env: { AEOLUS_MAX_SECONDS: '1' } }).exited).resolves.toMatchObject({ status: 6 });
    aTurnEnded();

    await expect(start('aeolus-wait.sh').exited).resolves.toEqual({ status: 0, stdout: 'aeolus: 1 deliveries wait for scout: receive them\n' });
  });

  it('forgets what it saw with the ship', async () => {
    fleet = await startStubFleet([inbox(1)]);
    crew(fleet.url);
    aTurnEnded();
    await start('aeolus-wait.sh').exited;

    run('aeolus-identity.sh', { args: ['delete'] });

    expect(readdirSync(data, { recursive: true }).map(String).filter((name) => name.startsWith('ships/'))).toEqual([]);
  });
});

describe('the Codex wake bridge', () => {
  const THREAD_ID = '01a103c9-80b0-7ab1-82e3-6f4a2f70ad86';

  /** A codex on PATH that writes down each call; the env to run the bridge with it, and the calls file. */
  function aCodex() {
    const bin = join(data, 'bin');
    const calls = join(data, 'codex.calls');
    mkdirSync(bin, { recursive: true });
    const codex = join(bin, 'codex');
    writeFileSync(codex, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${calls}"\n`);
    chmodSync(codex, 0o700);
    return { env: { PATH: `${bin}:${process.env.PATH ?? ''}` }, calls };
  }

  const queued = (calls: string) => (statSync(calls, { throwIfNoEntry: false }) ? readFileSync(calls, 'utf8') : '');

  it("logs arming for the Codex task in the plugin's log, and keeps no log of its own", async () => {
    fleet = await startStubFleet([inbox(1)]);
    crew(fleet.url);
    aTurnEnded();
    const codex = aCodex();

    await start('aeolus-codex-wake.sh', { args: ['start', THREAD_ID], env: codex.env }).exited;
    await expect.poll(() => queued(codex.calls), { timeout: 5_000 }).toContain(`queue --thread ${THREAD_ID}`);

    expect(actions()).toContainEqual({ ...scout, action: 'wakeBridge', outcome: `armed for Codex task ${THREAD_ID}` });
    expect(readdirSync(data, { recursive: true }).map(String).filter((name) => name.includes('.wake.log'))).toEqual([]);
  });

  it('logs a re-arm for the task it already wakes as already armed', async () => {
    let release = (): void => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    fleet = await startStubFleet([inbox(0), { ...inbox(1), hold }]);
    crew(fleet.url);
    aTurnEnded();
    const codex = aCodex();
    await start('aeolus-codex-wake.sh', { args: ['start', THREAD_ID], env: codex.env }).exited;

    try {
      await start('aeolus-codex-wake.sh', { args: ['start', THREAD_ID], env: codex.env }).exited;

      expect(actions().filter((record) => 'action' in record && record.action === 'wakeBridge')).toEqual([
        { ...scout, action: 'wakeBridge', outcome: `armed for Codex task ${THREAD_ID}` },
        { ...scout, action: 'wakeBridge', outcome: `already armed for Codex task ${THREAD_ID}` },
      ]);
    } finally {
      release();
      await expect.poll(() => queued(codex.calls), { timeout: 5_000 }).toContain(`queue --thread ${THREAD_ID}`);
    }
  });

  it('logs the wake it queues to the Codex task', async () => {
    fleet = await startStubFleet([inbox(1)]);
    crew(fleet.url);
    aTurnEnded();
    const codex = aCodex();

    await start('aeolus-codex-wake.sh', { args: ['run', THREAD_ID], env: codex.env }).exited;

    expect(actions().at(-1)).toEqual({ ...scout, action: 'wakeBridge', outcome: `queued a wake to Codex task ${THREAD_ID}: 1 delivery waits` });
  });

  it('logs a watcher that stopped without a wake as a failure, with what it said', async () => {
    crew();
    const watcher = aRunningWatcher();
    const codex = aCodex();

    try {
      await start('aeolus-codex-wake.sh', { args: ['run', THREAD_ID], env: codex.env }).exited;

      expect(actions().at(-1)).toEqual({
        ...scout,
        action: 'wakeBridge',
        outcome: 'failed: the watcher stopped: aeolus: already watching: a watcher runs for this ship; do not start another',
        next: 'the session arms it again before it ends its turn',
      });
    } finally {
      watcher.kill();
    }
  });

  it('logs a wake codex refused to queue as a failure, with what codex said', async () => {
    fleet = await startStubFleet([inbox(1)]);
    crew(fleet.url);
    aTurnEnded();
    const codex = aCodex();
    writeFileSync(join(data, 'bin', 'codex'), '#!/usr/bin/env bash\necho "no such thread" >&2\nexit 1\n');

    await start('aeolus-codex-wake.sh', { args: ['run', THREAD_ID], env: codex.env }).exited;

    expect(actions().at(-1)).toEqual({
      ...scout,
      action: 'wakeBridge',
      outcome: `failed: codex did not queue the wake to Codex task ${THREAD_ID}: no such thread`,
      next: 'the session arms it again before it ends its turn',
    });
  });

  it('logs not arming when its first fleet check cannot connect, as a failure with what happens next', () => {
    crew('http://127.0.0.1:1');
    const codex = aCodex();

    run('aeolus-codex-wake.sh', { args: ['start', THREAD_ID], env: codex.env });

    expect(actions().at(-1)).toEqual({
      ...scout,
      action: 'wakeBridge',
      outcome: 'failed: cannot reach the fleet, so automatic wake-up is not armed',
      next: 'the session arms it again before it ends its turn',
    });
  });

  it('refuses to look armed when its first fleet check cannot connect', () => {
    crew('http://127.0.0.1:1');
    const bin = join(data, 'bin');
    mkdirSync(bin);
    const codex = join(bin, 'codex');
    writeFileSync(codex, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(codex, 0o700);

    const started = run('aeolus-codex-wake.sh', {
      args: ['start', '01a103c9-80b0-7ab1-82e3-6f4a2f70ad86'],
      env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
    });

    expect(started.status).toBe(8);
    expect(started.stderr).toContain('cannot reach the fleet');
  });

  it('waits without model tokens, then queues one message to the exact Codex task', async () => {
    fleet = await startStubFleet([inbox(1)]);
    crew(fleet.url);
    aTurnEnded();
    const bin = join(data, 'bin');
    const calls = join(data, 'codex.calls');
    mkdirSync(bin);
    const codex = join(bin, 'codex');
    writeFileSync(codex, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${calls}"\n`);
    chmodSync(codex, 0o700);
    const threadId = '01a103c9-80b0-7ab1-82e3-6f4a2f70ad86';

    const result = await start('aeolus-codex-wake.sh', {
      args: ['run', threadId],
      env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
    }).exited;

    expect(result.status).toBe(0);
    expect(readFileSync(calls, 'utf8')).toContain(`queue --thread ${threadId} --message Aeolus has 1 delivery waiting for scout.`);
    expect(readFileSync(calls, 'utf8')).not.toContain(CREW_TOKEN);
  });

  it('detaches from SessionStart and still queues the task when a delivery arrives', async () => {
    fleet = await startStubFleet([inbox(1)]);
    crew(fleet.url);
    aTurnEnded();
    const bin = join(data, 'bin');
    const calls = join(data, 'codex.calls');
    mkdirSync(bin);
    const codex = join(bin, 'codex');
    writeFileSync(codex, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${calls}"\n`);
    chmodSync(codex, 0o700);
    const threadId = '01a103c9-80b0-7ab1-82e3-6f4a2f70ad86';

    await expect(
      start('aeolus-codex-wake.sh', {
        args: ['start', threadId],
        env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
      }).exited,
    ).resolves.toMatchObject({ status: 0, stdout: `aeolus: automatic wake-up armed for Codex task ${threadId}\n` });

    await expect.poll(() => (statSync(calls, { throwIfNoEntry: false }) ? readFileSync(calls, 'utf8') : ''), { timeout: 5_000 }).toContain(
      `queue --thread ${threadId}`,
    );
  });

  it('replaces a stale same-task pid instead of trusting an unrelated live process', async () => {
    fleet = await startStubFleet([inbox(1)]);
    crew(fleet.url);
    aTurnEnded();
    const unrelated = spawn('sleep', ['30']);
    const bin = join(data, 'bin');
    const calls = join(data, 'codex.calls');
    mkdirSync(bin);
    const codex = join(bin, 'codex');
    writeFileSync(codex, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${calls}"\n`);
    chmodSync(codex, 0o700);
    const threadId = '01a103c9-80b0-7ab1-82e3-6f4a2f70ad86';
    writeFileSync(wakePidFile(), `${String(unrelated.pid)}\n`);
    writeFileSync(wakeThreadFile(), `${threadId}\n`);

    try {
      await expect(
        start('aeolus-codex-wake.sh', {
          args: ['start', threadId],
          env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
        }).exited,
      ).resolves.toMatchObject({ status: 0, stdout: `aeolus: automatic wake-up armed for Codex task ${threadId}\n` });
      await expect.poll(() => (statSync(calls, { throwIfNoEntry: false }) ? readFileSync(calls, 'utf8') : ''), { timeout: 5_000 }).toContain(
        `queue --thread ${threadId}`,
      );
      expect(unrelated.exitCode).toBeNull();
    } finally {
      unrelated.kill();
    }
  });
});

const hookOutputSchema = z.object({
  hookSpecificOutput: z.object({ hookEventName: z.literal('SessionStart'), additionalContext: z.string() }),
});

describe('the SessionStart hook', () => {
  /** Runs the hook as Claude Code does: the payload on stdin, the plugin's variables set, no AEOLUS_ ones yet. */
  function hook(payload: Record<string, unknown>, projectFolder = '') {
    const envFile = join(data, 'session.env');
    writeFileSync(envFile, '');
    const result = run('aeolus-session-start.sh', {
      stdin: JSON.stringify(payload),
      env: { AEOLUS_FOLDER: '', AEOLUS_DATA: '', CLAUDE_PROJECT_DIR: projectFolder, CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: '/plugin', CLAUDE_ENV_FILE: envFile },
    });
    return { ...result, env: readFileSync(envFile, 'utf8') };
  }

  const payloadFor = (cwd: string, source = 'startup') => ({
    session_id: 'c5858406-be86-46cd-8591-f4fb39b1fa61',
    transcript_path: '/tmp/transcript.jsonl',
    cwd,
    hook_event_name: 'SessionStart',
    source,
  });

  it("exports the payload's folder and the plugin's paths for the session's commands", () => {
    const { env } = hook(payloadFor(folder));

    const exported = spawnSync('bash', ['-c', `. "$1"; printf '%s\\n' "$AEOLUS_FOLDER" "$AEOLUS_DATA" "$AEOLUS_ROOT"`, 'bash', join(data, 'session.env')]);
    expect(exported.stdout.toString()).toBe(`${folder}\n${data}\n/plugin\n`);
    expect(env).toContain('export AEOLUS_FOLDER=');
  });

  it('removes the .wake.log files an earlier plugin left beside the identities, and keeps the identities', () => {
    crew();
    const ships = dirname(identityFile());
    const left = ['0123456789abcdef0123456789abcdef.wake.log', basename(identityFile()).replace(/\.identity$/, '.wake.log')];
    for (const name of left) writeFileSync(join(ships, name), 'aeolus: automatic wake-up armed\n');

    expect(hook(payloadFor(folder)).status).toBe(0);

    expect(readdirSync(ships).filter((name) => name.endsWith('.wake.log'))).toEqual([]);
    expect(statSync(identityFile(), { throwIfNoEntry: false })).toBeDefined();
  });

  it('removes the .wake.log.wait.<pid> files an earlier wake bridge left when it was killed (#688)', () => {
    crew();
    const ships = dirname(identityFile());
    const gone = spawnSync('true').pid;
    const left = [`0123456789abcdef0123456789abcdef.wake.log.wait.${String(gone)}`, `${basename(identityFile(), '.identity')}.wake.log.wait.${String(gone)}`];
    for (const name of left) writeFileSync(join(ships, name), '');

    expect(hook(payloadFor(folder)).status).toBe(0);

    expect(readdirSync(ships).filter((name) => name.includes('.wake.log.wait.'))).toEqual([]);
  });

  it('keeps the .wake.log.wait.<pid> file of a wake bridge an earlier plugin still runs, which reads it when its watcher ends (#688)', () => {
    crew();
    const ships = dirname(identityFile());
    const bin = join(data, 'bin');
    mkdirSync(bin, { recursive: true });
    const bridge = join(bin, 'aeolus-codex-wake.sh');
    writeFileSync(bridge, '#!/usr/bin/env bash\nsleep 30\n');
    chmodSync(bridge, 0o700);
    const running = spawn('bash', [bridge]);
    const name = `${basename(identityFile(), '.identity')}.wake.log.wait.${String(running.pid)}`;
    writeFileSync(join(ships, name), '');

    try {
      expect(hook(payloadFor(folder)).status).toBe(0);

      expect(readdirSync(ships)).toContain(name);
    } finally {
      running.kill();
    }
  });

  it('removes the .wake.wait.<pid> files a wake bridge left when it was killed (#707)', () => {
    crew();
    const ships = dirname(identityFile());
    const gone = spawnSync('true').pid;
    const left = [`0123456789abcdef0123456789abcdef.wake.wait.${String(gone)}`, `${basename(identityFile(), '.identity')}.wake.wait.${String(gone)}`];
    for (const name of left) writeFileSync(join(ships, name), '');

    expect(hook(payloadFor(folder)).status).toBe(0);

    expect(readdirSync(ships).filter((name) => name.includes('.wake.wait.'))).toEqual([]);
  });

  it('keeps the .wake.wait.<pid> file of a wake bridge that still runs, which reads it when its watcher ends (#707)', () => {
    crew();
    const ships = dirname(identityFile());
    const bin = join(data, 'bin');
    mkdirSync(bin, { recursive: true });
    const bridge = join(bin, 'aeolus-codex-wake.sh');
    writeFileSync(bridge, '#!/usr/bin/env bash\nsleep 30\n');
    chmodSync(bridge, 0o700);
    const running = spawn('bash', [bridge]);
    const name = `${basename(identityFile(), '.identity')}.wake.wait.${String(running.pid)}`;
    writeFileSync(join(ships, name), '');

    try {
      expect(hook(payloadFor(folder)).status).toBe(0);

      expect(readdirSync(ships)).toContain(name);
    } finally {
      running.kill();
    }
  });

  it('says nothing to a folder that crews no ship', () => {
    expect(hook(payloadFor(folder))).toMatchObject({ status: 0, stdout: '' });
  });

  it('tells a fresh context after /clear which ship it crews, that aeolus-fleet.sh makes its fleet calls, and to start the watcher', () => {
    crew();

    const { status, stdout } = hook(payloadFor(folder, 'clear'));

    expect(status).toBe(0);
    const context = hookOutputSchema.parse(JSON.parse(stdout)).hookSpecificOutput.additionalContext;
    expect(context).toContain(`This folder crews the Aeolus ship scout (${SHIP_ID}) in the fleet at https://fleet.example.com.`);
    expect(context).toContain('Every fleet call goes through "/plugin/scripts/aeolus-fleet.sh", which adds the crew token: never read the identity file or pass a crew token.');
    expect(context).not.toContain('crewToken');
    expect(context).toContain('Do not register again.');
    expect(context).toContain('"/plugin/scripts/aeolus-wait.sh" as a background task');
    expect(context).toContain('When the watcher exits 6 (its 2-hour limit), just start it again.');
    expect(context).not.toContain(CREW_TOKEN);
  });

  it("tells a member's fresh context to check in at its flagship before anything else", () => {
    run('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', SHIP_ID, 'tester-k3x9', CREW_TOKEN, 'team-one'] });

    const { stdout } = hook(payloadFor(folder, 'compact'));

    const context = hookOutputSchema.parse(JSON.parse(stdout)).hookSpecificOutput.additionalContext;
    expect(context).toContain('This ship is a member of the squadron team-one.');
    expect(context).toContain('Before anything else, check in at its flagship team-one, as the aeolus crew-a-ship skill says for a squadron member.');
  });

  it('says nothing of a squadron to a ship that belongs to none', () => {
    crew();

    expect(hookOutputSchema.parse(JSON.parse(hook(payloadFor(folder)).stdout)).hookSpecificOutput.additionalContext).not.toContain('squadron');
  });

  it('keeps the folder the session started in after a compact while it works in a subfolder, so it still finds its ship (#334)', () => {
    crew();
    const subfolder = join(folder, 'packages', 'core');
    mkdirSync(subfolder, { recursive: true });

    const { stdout, env } = hook(payloadFor(subfolder, 'compact'), folder);

    const exported = spawnSync('bash', ['-c', `. "$1"; printf '%s' "$AEOLUS_FOLDER"`, 'bash', join(data, 'session.env')]);
    expect(exported.stdout.toString()).toBe(folder);
    expect(env).toContain('export AEOLUS_FOLDER=');
    expect(hookOutputSchema.parse(JSON.parse(stdout)).hookSpecificOutput.additionalContext).toContain(`This folder crews the Aeolus ship scout (${SHIP_ID})`);
  });

  it('keys the ship by the payload cwd, its JSON escapes undone, as the scripts do', () => {
    const windowsFolder = 'C:\\Users\\thomas\\fleet "work"';
    run('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', SHIP_ID, 'scout', CREW_TOKEN], env: { AEOLUS_FOLDER: windowsFolder } });

    const { stdout } = hook(payloadFor(windowsFolder));

    expect(hookOutputSchema.parse(JSON.parse(stdout)).hookSpecificOutput.additionalContext).toContain('crews the Aeolus ship scout');
  });
});

/** A process named like the watcher that holds this folder's lock, as a running watcher does. */
function aRunningWatcher() {
  const bin = join(data, 'bin');
  mkdirSync(bin, { recursive: true });
  const watcher = join(bin, 'aeolus-wait.sh');
  writeFileSync(watcher, '#!/usr/bin/env bash\nsleep 30\n');
  chmodSync(watcher, 0o700);
  const process = spawn('bash', [watcher]);
  writeFileSync(pidFile(), `${String(process.pid)}\n`);
  return process;
}

/** Runs a hook as Claude Code does: the payload on stdin, the plugin's variables and the project folder set, no AEOLUS_ ones. */
function claudeHook(script: string, payload: Record<string, unknown>) {
  return run(script, {
    stdin: JSON.stringify({ session_id: 'c5858406-be86-46cd-8591-f4fb39b1fa61', cwd: folder, ...payload }),
    env: { AEOLUS_FOLDER: '', AEOLUS_DATA: '', CLAUDE_PROJECT_DIR: folder, CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: '/plugin' },
  });
}

describe('the watcher guard (PreToolUse on Bash)', () => {
  const startingTheWatcher = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: '"/plugin/scripts/aeolus-wait.sh"', run_in_background: true },
  };

  it('refuses to start a second watcher, saying already running, so the session is not woken with nothing to read', () => {
    crew();
    const watcher = aRunningWatcher();

    try {
      const { status, stdout } = claudeHook('aeolus-watch-guard.sh', startingTheWatcher);

      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'aeolus: already running: a watcher runs for scout; do nothing else',
        },
      });
    } finally {
      watcher.kill();
    }
  });

  it('lets the watcher start when none runs', () => {
    crew();

    expect(claudeHook('aeolus-watch-guard.sh', startingTheWatcher)).toMatchObject({ status: 0, stdout: '' });
  });

  it('lets a command that only names the watcher run in the foreground', () => {
    crew();
    const watcher = aRunningWatcher();

    try {
      expect(
        claudeHook('aeolus-watch-guard.sh', { ...startingTheWatcher, tool_input: { command: 'cat "/plugin/scripts/aeolus-wait.sh"' } }),
      ).toMatchObject({ status: 0, stdout: '' });
    } finally {
      watcher.kill();
    }
  });
});

describe('the Stop hook', () => {
  const endingTheTurn = { hook_event_name: 'Stop', stop_hook_active: false };

  it('keeps the turn open to start the watcher when the folder crews a ship and none runs, so no session has to remember', () => {
    crew();

    const { status, stdout } = claudeHook('aeolus-stop.sh', endingTheTurn);

    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      decision: 'block',
      reason:
        'aeolus: no watcher runs for scout, so nothing wakes this session when work arrives: start "/plugin/scripts/aeolus-wait.sh" as a background task (run_in_background), then end your turn',
    });
  });

  it('leaves the turn busy while it keeps the turn open to ask for the watcher', () => {
    crew();
    aPromptSubmitted();

    claudeHook('aeolus-stop.sh', endingTheTurn);

    expect(turn().stdout).toMatch(/^busy /);
  });

  it('marks the turn idle when it lets the turn end', () => {
    crew();
    const watcher = aRunningWatcher();

    try {
      claudeHook('aeolus-stop.sh', endingTheTurn);
      expect(turn().stdout).toMatch(/^idle /);
    } finally {
      watcher.kill();
    }
  });

  it('lets the turn end while a watcher runs', () => {
    crew();
    const watcher = aRunningWatcher();

    try {
      expect(claudeHook('aeolus-stop.sh', endingTheTurn)).toMatchObject({ status: 0, stdout: '' });
    } finally {
      watcher.kill();
    }
  });

  it('lets the turn end in a folder that crews no ship', () => {
    expect(claudeHook('aeolus-stop.sh', endingTheTurn)).toMatchObject({ status: 0, stdout: '' });
  });

  it('keeps a turn open once only, so it never loops', () => {
    crew();

    expect(claudeHook('aeolus-stop.sh', { ...endingTheTurn, stop_hook_active: true })).toMatchObject({ status: 0, stdout: '' });
  });

  it('lets the turn end once the fleet refused the crew token, so a refused watcher is not started over and over', async () => {
    fleet = await startStubFleet([{ status: 401, body: { code: 'UNAUTHORIZED', message: 'Call with the crew token' } }]);
    crew(fleet.url);
    await start('aeolus-wait.sh').exited;

    expect(claudeHook('aeolus-stop.sh', endingTheTurn)).toMatchObject({ status: 0, stdout: '' });
  });

  it('asks for the watcher again once a watcher reached the fleet with the crew token', async () => {
    fleet = await startStubFleet([{ status: 401, body: { code: 'UNAUTHORIZED', message: 'Call with the crew token' } }, inbox(1)]);
    crew(fleet.url);
    aTurnEnded();
    await start('aeolus-wait.sh').exited;
    await start('aeolus-wait.sh').exited;

    expect(claudeHook('aeolus-stop.sh', endingTheTurn).stdout).toContain('"decision":"block"');
  });

  it('re-arms the Codex wake bridge for the task by itself at the end of every turn', async () => {
    fleet = await startStubFleet([inbox(1)]);
    crew(fleet.url, AS_CODEX);
    aTurnEnded();
    const bin = join(data, 'bin');
    const calls = join(data, 'codex.calls');
    mkdirSync(bin);
    const codex = join(bin, 'codex');
    writeFileSync(codex, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${calls}"\n`);
    chmodSync(codex, 0o700);
    const threadId = '01a103c9-80b0-7ab1-82e3-6f4a2f70ad86';

    // Started, not run: the stub fleet answers the bridge's first check only while the test does not block.
    const ended = await start('aeolus-stop.sh', {
      stdin: JSON.stringify({ session_id: threadId, cwd: folder, hook_event_name: 'Stop', stop_hook_active: false }),
      env: { AEOLUS_FOLDER: '', AEOLUS_DATA: '', CLAUDE_PROJECT_DIR: '', PLUGIN_DATA: data, PLUGIN_ROOT: '/plugin', PATH: `${bin}:${process.env.PATH ?? ''}` },
    }).exited;

    expect(ended).toMatchObject({ status: 0, stdout: '' });
    await expect.poll(() => (statSync(calls, { throwIfNoEntry: false }) ? readFileSync(calls, 'utf8') : ''), { timeout: 5_000 }).toContain(
      `queue --thread ${threadId}`,
    );
  });
});

describe("a squadron member's check-in interval", () => {
  const MINUTE = 60;
  const reminder =
    'aeolus: 30m, the check-in interval of the squadron team-one, passed since tester-k3x9 last reported: report what you are doing now with the report call, such as {"state":"working","note":"reviewing PR 89"}, then go on';

  function aMember(interval = '30m'): void {
    run('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', SHIP_ID, 'tester-k3x9', CREW_TOKEN, 'team-one'] });
    expect(run('aeolus-identity.sh', { args: ['check-in', interval] }).status).toBe(0);
  }

  function reportedFile(): string {
    return identityFile().replace(/\.identity$/, '.reported');
  }

  /** The member last reported this many seconds ago. */
  function lastReported(secondsAgo: number): void {
    writeFileSync(reportedFile(), `${String(Math.floor(Date.now() / 1000) - secondsAgo)}\n`);
  }

  const aToolCall = { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/tmp/x' } };

  function contextOf(stdout: string): string {
    return z.object({ hookSpecificOutput: z.object({ hookEventName: z.literal('PostToolUse'), additionalContext: z.string() }) }).parse(JSON.parse(stdout))
      .hookSpecificOutput.additionalContext;
  }

  it('keeps the interval the role message gives, and shows it', () => {
    aMember();

    expect(run('aeolus-identity.sh', { args: ['show'] }).stdout).toContain('check-in: 30m\n');
  });

  it('refuses an interval in another form than <n>m or <n>h', () => {
    run('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', SHIP_ID, 'tester-k3x9', CREW_TOKEN, 'team-one'] });

    expect(run('aeolus-identity.sh', { args: ['check-in', '30 min'] }).status).toBe(2);
    expect(run('aeolus-identity.sh', { args: ['show'] }).stdout).not.toContain('check-in');
  });

  it('reminds the session to report once the interval passed since its last report, so a long run never looks like silence', () => {
    aMember();
    lastReported(31 * MINUTE);

    const { status, stdout } = claudeHook('aeolus-report-due.sh', aToolCall);

    expect(status).toBe(0);
    expect(contextOf(stdout)).toBe(reminder);
  });

  it('says nothing while the interval has not passed', () => {
    aMember();
    lastReported(29 * MINUTE);

    expect(claudeHook('aeolus-report-due.sh', aToolCall)).toMatchObject({ status: 0, stdout: '' });
  });

  it('reads an interval in hours', () => {
    aMember('2h');
    lastReported(119 * MINUTE);

    expect(claudeHook('aeolus-report-due.sh', aToolCall).stdout).toBe('');
  });

  it('reminds once per interval, not after every call', () => {
    aMember();
    lastReported(31 * MINUTE);

    claudeHook('aeolus-report-due.sh', aToolCall);

    expect(claudeHook('aeolus-report-due.sh', aToolCall).stdout).toBe('');
  });

  it('starts the clock at the first call when the member has not reported yet', () => {
    aMember();

    expect(claudeHook('aeolus-report-due.sh', aToolCall).stdout).toBe('');
    expect(statSync(reportedFile(), { throwIfNoEntry: false })).toBeDefined();
  });

  it('counts a report through the report tool', () => {
    aMember();
    lastReported(31 * MINUTE);

    claudeHook('aeolus-report-due.sh', { hook_event_name: 'PostToolUse', tool_name: 'mcp__aeolus__report', tool_input: { state: 'working' } });

    expect(claudeHook('aeolus-report-due.sh', aToolCall).stdout).toBe('');
  });

  it("counts a report through the fleet's REST door", () => {
    aMember();
    lastReported(31 * MINUTE);

    expect(
      claudeHook('aeolus-report-due.sh', {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'curl -X POST https://fleet.example.com/api/v1/ship/report -d \'{"state":"idle"}\'' },
      }).stdout,
    ).toBe('');
    expect(claudeHook('aeolus-report-due.sh', aToolCall).stdout).toBe('');
  });

  it('says nothing to a ship that belongs to no squadron, which has no interval (decided: no reminders for plain ships)', () => {
    crew();
    writeFileSync(identityFile().replace(/\.identity$/, '.reported'), '0\n');

    expect(claudeHook('aeolus-report-due.sh', aToolCall)).toMatchObject({ status: 0, stdout: '' });
  });

  it("brings the interval back to a member's fresh context after /clear or compaction", () => {
    aMember();
    const envFile = join(data, 'session.env');
    writeFileSync(envFile, '');

    const { stdout } = run('aeolus-session-start.sh', {
      stdin: JSON.stringify({ session_id: 'c5858406-be86-46cd-8591-f4fb39b1fa61', cwd: folder, hook_event_name: 'SessionStart', source: 'compact' }),
      env: { AEOLUS_FOLDER: '', AEOLUS_DATA: '', CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: '/plugin', CLAUDE_ENV_FILE: envFile },
    });

    expect(hookOutputSchema.parse(JSON.parse(stdout)).hookSpecificOutput.additionalContext).toContain(
      'Its check-in interval is 30m: report at least once per interval; the plugin reminds you when one passes without a report.',
    );
  });
});

describe('a folder a trierarch crews (wakeBy=trierarch)', () => {
  const TURN_MARKER = /^(busy|idle) \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

  function crewedByATrierarch(env: Record<string, string> = {}): void {
    expect(run('aeolus-identity.sh', { args: ['write', '--wake-by', 'trierarch', 'https://fleet.example.com', SHIP_ID, 'scout', CREW_TOKEN], env }).status).toBe(0);
  }

  function sessionStart(env: Record<string, string>) {
    const envFile = join(data, 'session.env');
    writeFileSync(envFile, '');
    const { stdout } = run('aeolus-session-start.sh', {
      stdin: JSON.stringify({ session_id: 'c5858406-be86-46cd-8591-f4fb39b1fa61', cwd: folder, hook_event_name: 'SessionStart', source: 'startup' }),
      env: { AEOLUS_FOLDER: '', AEOLUS_DATA: '', CLAUDE_ENV_FILE: envFile, ...env },
    });
    return hookOutputSchema.parse(JSON.parse(stdout)).hookSpecificOutput.additionalContext;
  }

  /** Runs a hook as Codex does: PLUGIN_ROOT and PLUGIN_DATA set, the task id in the payload. */
  function codexHook(script: string, payload: Record<string, unknown>) {
    return run(script, {
      stdin: JSON.stringify({ session_id: '01a103c9-80b0-7ab1-82e3-6f4a2f70ad86', cwd: folder, ...payload }),
      env: { AEOLUS_FOLDER: '', AEOLUS_DATA: '', CLAUDE_PROJECT_DIR: '', PLUGIN_DATA: data, PLUGIN_ROOT: SCRIPTS.replace(/\/scripts\/$/, '') },
    });
  }

  it('keeps wakeBy=trierarch in the identity file when asked, and shows it', () => {
    crewedByATrierarch();

    expect(readFileSync(identityFile(), 'utf8')).toContain('wakeBy=trierarch\n');
    expect(run('aeolus-identity.sh', { args: ['show'] }).stdout).toContain('wakes: the trierarch');
  });

  it('keeps the squadron beside it, for a member a trierarch crews', () => {
    run('aeolus-identity.sh', { args: ['write', '--wake-by', 'trierarch', 'https://fleet.example.com', SHIP_ID, 'tester-k3x9', CREW_TOKEN, 'team-one'] });

    expect(readFileSync(identityFile(), 'utf8')).toMatch(/squadron=team-one\n[\s\S]*wakeBy=trierarch\n|wakeBy=trierarch\n[\s\S]*squadron=team-one\n/);
  });

  it('refuses to wake by anything but the trierarch', () => {
    const written = run('aeolus-identity.sh', { args: ['write', '--wake-by', 'cron', 'https://fleet.example.com', SHIP_ID, 'scout', CREW_TOKEN] });

    expect(written.status).toBe(2);
    expect(statSync(identityFile(), { throwIfNoEntry: false })).toBeUndefined();
  });

  it('tells a fresh Claude Code context to start no watcher, since the trierarch wakes it', () => {
    crewedByATrierarch();

    const context = sessionStart({ CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: '/plugin' });

    expect(context).toContain('The trierarch wakes this session when work arrives: start no watcher.');
    expect(context).not.toContain('aeolus-wait.sh');
  });

  it('starts no Codex wake bridge at session start, and says the trierarch wakes it', () => {
    crewedByATrierarch(AS_CODEX);

    const context = sessionStart({ PLUGIN_DATA: data, PLUGIN_ROOT: SCRIPTS.replace(/\/scripts\/$/, '') });

    expect(context).toContain('The trierarch wakes this session when work arrives: start no watcher.');
    expect(context).not.toContain('wake-up');
    expect(statSync(wakePidFile(AS_CODEX), { throwIfNoEntry: false })).toBeUndefined();
  });

  it('refuses to start a watcher in the background, saying the trierarch wakes the session', () => {
    crewedByATrierarch();

    const { stdout } = claudeHook('aeolus-watch-guard.sh', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: '"/plugin/scripts/aeolus-wait.sh"', run_in_background: true },
    });

    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'aeolus: the trierarch wakes scout; start no watcher and do nothing else',
      },
    });
  });

  it('lets a Claude Code turn end with no watcher running', () => {
    crewedByATrierarch();

    expect(claudeHook('aeolus-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false })).toMatchObject({ status: 0, stdout: '' });
  });

  it('arms no Codex wake bridge at the end of a turn', () => {
    crewedByATrierarch(AS_CODEX);

    expect(codexHook('aeolus-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false })).toMatchObject({ status: 0, stdout: '' });
    expect(statSync(wakePidFile(AS_CODEX), { throwIfNoEntry: false })).toBeUndefined();
  });

  it('marks the turn busy when a prompt is submitted, with when', () => {
    crewedByATrierarch();

    expect(claudeHook('aeolus-turn.sh', { hook_event_name: 'UserPromptSubmit', prompt: '/aeolus:wake' })).toMatchObject({ status: 0, stdout: '' });

    const { status, stdout } = turn();
    expect(status).toBe(0);
    expect(stdout.trim()).toMatch(TURN_MARKER);
    expect(stdout).toMatch(/^busy /);
  });

  it('marks the turn idle when it ends, with when', () => {
    crewedByATrierarch();
    claudeHook('aeolus-turn.sh', { hook_event_name: 'UserPromptSubmit', prompt: '/aeolus:wake' });

    claudeHook('aeolus-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false });

    expect(turn().stdout.trim()).toMatch(TURN_MARKER);
    expect(turn().stdout).toMatch(/^idle /);
  });

  it('marks the turn in a Codex session alike', () => {
    crewedByATrierarch(AS_CODEX);

    codexHook('aeolus-turn.sh', { hook_event_name: 'UserPromptSubmit', prompt: '/aeolus:wake' });
    expect(turn(AS_CODEX).stdout).toMatch(/^busy /);
    codexHook('aeolus-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false });
    expect(turn(AS_CODEX).stdout).toMatch(/^idle /);
  });

  it('says no turn has been marked before the first prompt', () => {
    crewedByATrierarch();

    expect(turn()).toMatchObject({ status: 1, stdout: 'aeolus: no turn marked yet\n' });
  });

  it('forgets the turn marker with the ship', () => {
    crewedByATrierarch();
    claudeHook('aeolus-turn.sh', { hook_event_name: 'UserPromptSubmit', prompt: '/aeolus:wake' });

    run('aeolus-identity.sh', { args: ['delete'] });

    expect(readdirSync(data, { recursive: true }).map(String).filter((name) => name.endsWith('.turn'))).toEqual([]);
  });
});

describe("the launch marker: what a session's hooks saw of the launch the trierarch started it for (#490)", () => {
  const LAUNCH = 'lnc-2026-10-12T05:00:00.000Z';
  const TRANSCRIPT = '/home/someone/.claude/projects/-a folder/c5858406.jsonl';
  const WHEN = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z';

  function crewedByATrierarch(): void {
    expect(run('aeolus-identity.sh', { args: ['write', '--wake-by', 'trierarch', 'https://fleet.example.com', SHIP_ID, 'scout', CREW_TOKEN] }).status).toBe(0);
  }

  /** Runs the launch hook as Claude Code does, in a session the trierarch started with the launch id given, or none (null). */
  function claudeLaunchHook(payload: Record<string, unknown>, launch: string | null = LAUNCH) {
    return run('aeolus-launch.sh', {
      stdin: JSON.stringify({ session_id: 'c5858406-be86-46cd-8591-f4fb39b1fa61', transcript_path: TRANSCRIPT, cwd: folder, ...payload }),
      env: { AEOLUS_FOLDER: '', AEOLUS_DATA: '', CLAUDE_PROJECT_DIR: folder, CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: '/plugin', ...(launch !== null && { AEOLUS_LAUNCH: launch }) },
    });
  }

  /** Runs the launch hook as Codex does: PLUGIN_ROOT and PLUGIN_DATA set, the folder only in the payload. */
  function codexLaunchHook(payload: Record<string, unknown>) {
    return run('aeolus-launch.sh', {
      stdin: JSON.stringify({ session_id: '01a103c9-80b0-7ab1-82e3-6f4a2f70ad86', cwd: folder, ...payload }),
      env: { AEOLUS_FOLDER: '', AEOLUS_DATA: '', CLAUDE_PROJECT_DIR: '', PLUGIN_DATA: data, PLUGIN_ROOT: SCRIPTS.replace(/\/scripts\/$/, ''), AEOLUS_LAUNCH: LAUNCH },
    });
  }

  const sessionStarted = { hook_event_name: 'SessionStart', source: 'startup' };
  const aToolCall = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/etc/hostname' } };
  const modelRefused = {
    hook_event_name: 'StopFailure',
    error: 'model_not_found',
    last_assistant_message: "There's an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it.",
  };

  function launch(env: Record<string, string> = {}): Run {
    return run('aeolus-identity.sh', { args: ['launch'], env });
  }

  it('records that the session started, with its transcript, for the launch it belongs to', () => {
    crewedByATrierarch();

    claudeLaunchHook(sessionStarted);

    expect(launch().stdout).toMatch(new RegExp(`^launch ${LAUNCH}\\nstarted ${WHEN} ${TRANSCRIPT}\\n$`, 'u'));
  });

  it('records activity at the first tool call of any tool, once', () => {
    crewedByATrierarch();
    claudeLaunchHook(sessionStarted);

    claudeLaunchHook(aToolCall);
    claudeLaunchHook({ ...aToolCall, tool_name: 'Bash', tool_input: { command: 'ls' } });

    expect(launch().stdout).toMatch(new RegExp(`^launch ${LAUNCH}\\nstarted ${WHEN} .*\\nactive ${WHEN}\\n$`, 'u'));
  });

  it('records the model refused, by the id its message names, when the turn failed because the model was not found', () => {
    crewedByATrierarch();
    claudeLaunchHook(sessionStarted);

    claudeLaunchHook(modelRefused);

    expect(launch().stdout).toMatch(new RegExp(`\\nrefused ${WHEN} claude-nonexistent-9\\n$`, 'u'));
  });

  it('records the refusal without an id when its message names no model', () => {
    crewedByATrierarch();
    claudeLaunchHook(sessionStarted);

    claudeLaunchHook({ ...modelRefused, last_assistant_message: 'The model could not be found.' });

    expect(launch().stdout).toMatch(new RegExp(`\\nrefused ${WHEN}\\n$`, 'u'));
  });

  it('records no refusal for a turn that failed for another reason, such as a rate limit', () => {
    crewedByATrierarch();
    claudeLaunchHook(sessionStarted);

    claudeLaunchHook({ ...modelRefused, error: 'rate_limit' });

    expect(launch().stdout).not.toContain('refused');
  });

  it('starts the marker over for another launch, so nothing from an earlier session counts', () => {
    crewedByATrierarch();
    claudeLaunchHook(sessionStarted, 'lnc-earlier');
    claudeLaunchHook(aToolCall, 'lnc-earlier');

    claudeLaunchHook(sessionStarted);

    expect(launch().stdout).toMatch(new RegExp(`^launch ${LAUNCH}\\nstarted ${WHEN} .*\\n$`, 'u'));
  });

  it('records nothing for a session started without a launch id, as one crewed by hand', () => {
    crewedByATrierarch();

    claudeLaunchHook(sessionStarted, null);
    claudeLaunchHook(aToolCall, null);

    expect(launch()).toMatchObject({ status: 1, stdout: 'aeolus: no launch marked yet\n' });
  });

  it('records nothing in a folder that crews no ship', () => {
    claudeLaunchHook(sessionStarted);

    expect(launch().status).toBe(1);
  });

  it('never fails the session, and says nothing to it', () => {
    crewedByATrierarch();

    expect(claudeLaunchHook(sessionStarted)).toMatchObject({ status: 0, stdout: '', stderr: '' });
    expect(claudeLaunchHook(aToolCall)).toMatchObject({ status: 0, stdout: '', stderr: '' });
  });

  it('records the start and the first tool call of a Codex session, in the Codex crews folder', () => {
    run('aeolus-identity.sh', { args: ['write', '--wake-by', 'trierarch', 'https://fleet.example.com', SHIP_ID, 'scout', CREW_TOKEN], env: AS_CODEX });

    codexLaunchHook({ ...sessionStarted, transcript_path: '/home/someone/.codex/sessions/2026/10/12/rollout-x.jsonl' });
    codexLaunchHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });

    expect(launch(AS_CODEX).stdout).toMatch(new RegExp(`^launch ${LAUNCH}\\nstarted ${WHEN} /home/someone/\\.codex/sessions/2026/10/12/rollout-x\\.jsonl\\nactive ${WHEN}\\n$`, 'u'));
  });

  it('clears the marker when the trierarch asks, before it starts the next launch', () => {
    crewedByATrierarch();
    claudeLaunchHook(sessionStarted);

    expect(run('aeolus-identity.sh', { args: ['launch', 'clear'] }).status).toBe(0);

    expect(launch().status).toBe(1);
  });

  it('forgets the launch marker with the ship', () => {
    crewedByATrierarch();
    claudeLaunchHook(sessionStarted);

    run('aeolus-identity.sh', { args: ['delete'] });

    expect(readdirSync(home, { recursive: true }).map(String).filter((name) => name.endsWith('.launch'))).toEqual([]);
  });
});

describe("the plugin's log: what the watcher and hooks do, one record per line in the trierarch's log format", () => {
  const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

  it("writes each record as the trierarch's log does: when, the ship, the action and its outcome", async () => {
    fleet = await startStubFleet([inbox(2)]);
    crew(fleet.url);
    aTurnEnded();

    await start('aeolus-wait.sh').exited;

    const records = logged();
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record).toMatchObject({ shipId: SHIP_ID, shipName: 'scout' });
      expect('time' in record && record.time).toMatch(ISO_TIME);
    }
  });

  it('logs the watcher starting and the wake it gives', async () => {
    fleet = await startStubFleet([inbox(0), inbox(2)]);
    crew(fleet.url);
    aTurnEnded();

    await start('aeolus-wait.sh').exited;

    expect(actions().slice(1)).toEqual([
      { ...scout, action: 'watch', outcome: 'started' },
      { ...scout, action: 'wake', outcome: 'woken, 2 deliveries wait' },
    ]);
  });

  it('logs a wake it holds while the session is busy once, not on every check', async () => {
    fleet = await startStubFleet([inbox(1)]);
    const stub = fleet;
    crew(stub.url);
    aPromptSubmitted();
    const watcher = start('aeolus-wait.sh');

    try {
      await expect.poll(() => stub.calls.length).toBeGreaterThanOrEqual(3);
      expect(actions().filter((record) => 'action' in record && record.action === 'wake')).toEqual([
        { ...scout, action: 'wake', outcome: 'held, 1 deliveries wait while the session is busy' },
      ]);
    } finally {
      watcher.child.kill();
    }
  });

  it('logs that a second watcher did not start', () => {
    crew();
    const watcher = aRunningWatcher();

    try {
      run('aeolus-wait.sh');

      expect(actions()).toEqual([{ ...scout, action: 'watch', outcome: 'not started: a watcher runs for this ship' }]);
    } finally {
      watcher.kill();
    }
  });

  it('logs the release on LEASE_ENDED, after which the plugin forgot the ship', async () => {
    fleet = await startStubFleet([{ status: 401, body: { code: 'LEASE_ENDED', message: 'This ship was released' } }]);
    crew(fleet.url);

    await start('aeolus-wait.sh').exited;

    expect(actions().at(-1)).toEqual({ ...scout, action: 'release', outcome: 'released by the operator; the plugin forgot it' });
  });

  it('logs a refused crew token as a failure, with what happens next', async () => {
    fleet = await startStubFleet([{ status: 401, body: { code: 'UNAUTHORIZED', message: 'Call with the crew token' } }]);
    crew(fleet.url);

    await start('aeolus-wait.sh').exited;

    expect(actions().at(-1)).toEqual({
      ...scout,
      action: 'watch',
      outcome: 'failed: the fleet refused the crew token',
      next: 'no watcher is asked for until one reaches the fleet with the crew token',
    });
  });

  it('logs a failing fleet once, not every retry, and when it answers again', async () => {
    fleet = await startStubFleet([{ status: 500, body: {} }, { status: 503, body: {} }, inbox(0), inbox(1)]);
    crew(fleet.url);
    aTurnEnded();

    await start('aeolus-wait.sh').exited;

    expect(actions().slice(2, 4)).toEqual([
      { ...scout, action: 'watch', outcome: 'failed: the fleet answered HTTP 500', next: 'retries, a little later each time' },
      { ...scout, action: 'watch', outcome: 'the fleet answers again' },
    ]);
  });

  it('logs a fleet that does not answer at all', async () => {
    crew('http://127.0.0.1:9');
    const watcher = start('aeolus-wait.sh', { env: { AEOLUS_RETRY_SECONDS: '1' } });

    try {
      await expect.poll(() => actions().at(-1)).toEqual({
        ...scout,
        action: 'watch',
        outcome: 'failed: no answer from the fleet',
        next: 'retries, a little later each time',
      });
    } finally {
      watcher.child.kill();
    }
  });

  it('logs that the watcher stopped at its time limit', async () => {
    fleet = await startStubFleet([inbox(0)]);
    crew(fleet.url);

    await start('aeolus-wait.sh', { env: { AEOLUS_WAIT_SECONDS: '0', AEOLUS_MAX_SECONDS: '1' } }).exited;

    expect(actions().at(-1)).toEqual({ ...scout, action: 'watch', outcome: 'stopped after almost 2 hours; the session starts it again' });
  });

  it('logs the turn busy when a prompt is submitted, and idle when it ends', () => {
    crew();
    const watcher = aRunningWatcher();

    try {
      aPromptSubmitted();
      claudeHook('aeolus-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false });

      expect(actions()).toEqual([
        { ...scout, action: 'turn', outcome: 'busy: a prompt was submitted' },
        { ...scout, action: 'turn', outcome: 'idle: the turn ended' },
      ]);
    } finally {
      watcher.kill();
    }
  });

  it('logs that the Stop hook kept the turn open to ask for the watcher', () => {
    crew();

    claudeHook('aeolus-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false });

    expect(actions()).toEqual([{ ...scout, action: 'askWatcher', outcome: 'kept the turn open: no watcher runs' }]);
  });

  it('logs a watcher the guard refused, and why', () => {
    crew();
    const watcher = aRunningWatcher();

    try {
      claudeHook('aeolus-watch-guard.sh', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: '"/plugin/scripts/aeolus-wait.sh"', run_in_background: true },
      });

      expect(actions()).toEqual([{ ...scout, action: 'refuseWatcher', outcome: 'refused: a watcher runs for this ship' }]);
    } finally {
      watcher.kill();
    }
  });

  it('logs what the SessionStart hook told a fresh context, and after what', () => {
    crew();

    run('aeolus-session-start.sh', {
      stdin: JSON.stringify({ session_id: 'c5858406-be86-46cd-8591-f4fb39b1fa61', cwd: folder, hook_event_name: 'SessionStart', source: 'clear' }),
      env: { AEOLUS_FOLDER: '', AEOLUS_DATA: '', CLAUDE_PROJECT_DIR: folder, CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: '/plugin' },
    });

    expect(actions()).toEqual([{ ...scout, action: 'sessionStart', outcome: 'told the session after clear which ship it crews, and to start the watcher' }]);
  });

  it('logs a report reminder', () => {
    run('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', SHIP_ID, 'tester-k3x9', CREW_TOKEN, 'team-one'] });
    run('aeolus-identity.sh', { args: ['check-in', '30m'] });
    writeFileSync(identityFile().replace(/\.identity$/, '.reported'), `${String(Math.floor(Date.now() / 1000) - 31 * 60)}\n`);

    claudeHook('aeolus-report-due.sh', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/tmp/x' } });

    expect(actions()).toEqual([
      { time: undefined, shipId: SHIP_ID, shipName: 'tester-k3x9', action: 'remind', outcome: 'reminded to report: 30m passed since the last report' },
    ]);
  });

  it('logs the model the session runs when it changes, not on every fleet call', () => {
    crew();
    const aFleetCall = (model: string) => ({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: '"/plugin/scripts/aeolus-fleet.sh" inbox' },
      model,
    });

    claudeHook('aeolus-model.sh', aFleetCall('gpt-5.5'));
    claudeHook('aeolus-model.sh', aFleetCall('gpt-5.5'));
    claudeHook('aeolus-model.sh', aFleetCall('gpt-5.5-mini'));

    expect(actions()).toEqual([
      { ...scout, action: 'model', outcome: 'the session runs gpt-5.5' },
      { ...scout, action: 'model', outcome: 'the session runs gpt-5.5-mini' },
    ]);
  });

  it('logs nothing for a folder that crews no ship', () => {
    aPromptSubmitted();
    aTurnEnded();
    run('aeolus-wait.sh');

    expect(logged()).toEqual([]);
  });

  it('keeps the log when the plugin forgets the ship, and never logs the crew token', () => {
    crew();
    aPromptSubmitted();

    run('aeolus-identity.sh', { args: ['delete'] });

    expect(logged()).toHaveLength(1);
    expect(readFileSync(join(data, 'logs', 'aeolus.log'), 'utf8')).not.toContain(CREW_TOKEN);
  });
});

describe("the plugin's log is capped: at its size limit it moves aside as aeolus.log.1 and a new log starts", () => {
  const MIB = 1024 * 1024;
  const log = () => join(data, 'logs', 'aeolus.log');
  const previous = () => join(data, 'logs', 'aeolus.log.1');

  /** A log of exactly this many bytes of filler lines. */
  function aLogOf(bytes: number, marker = 'x'): string {
    mkdirSync(join(data, 'logs'), { recursive: true });
    const line = `${marker.repeat(99)}\n`;
    const content = line.repeat(Math.floor(bytes / line.length)) + marker.repeat(bytes % line.length);
    writeFileSync(log(), content);
    return content;
  }

  const read = (file: string) => (statSync(file, { throwIfNoEntry: false }) ? readFileSync(file, 'utf8') : undefined);

  /** A prompt submitted, logged by a plugin whose log limit is 1000 bytes. */
  function aPromptSubmittedUnderALimitOf1000Bytes(): void {
    const submitted = run('aeolus-turn.sh', {
      stdin: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' }),
      env: { AEOLUS_LOG_MAX_BYTES: '1000' },
    });
    expect(submitted.status).toBe(0);
  }

  it('moves a log that reached the limit aside before the next record, which starts the new log', () => {
    crew();
    const older = aLogOf(1000);

    aPromptSubmittedUnderALimitOf1000Bytes();

    expect(read(previous())).toBe(older);
    expect(readLogLine((read(log()) ?? '').trimEnd())).toMatchObject({ shipId: SHIP_ID, action: 'turn' });
  });

  it('keeps appending to a log one byte under the limit', () => {
    crew();
    const older = aLogOf(999);

    aPromptSubmittedUnderALimitOf1000Bytes();

    expect(read(previous())).toBeUndefined();
    expect(read(log())?.startsWith(`${older}{`)).toBe(true);
  });

  it('keeps one previous log: a second move aside replaces the first', () => {
    crew();
    aLogOf(1000, 'a');
    aPromptSubmittedUnderALimitOf1000Bytes();
    const second = aLogOf(1000, 'b');

    aPromptSubmittedUnderALimitOf1000Bytes();

    expect(read(previous())).toBe(second);
    expect(readdirSync(join(data, 'logs')).sort()).toEqual(['aeolus.log', 'aeolus.log.1']);
  });

  /** What a held step waits for: the other writer wrote its record, or moved the log aside and let go of the lock. */
  const until = {
    aRecordWritten: () => `cat "${log()}" "${previous()}" 2>/dev/null | grep -q '"action":"turn"'`,
    theLogMovedAside: () => `[ -f "${previous()}" ] && [ ! -d "${log()}.lock" ]`,
  };

  interface Hold {
    /** The command of the move aside to hold: the look at the size, the move, or the lock let go. */
    step: 'wc' | 'mv' | 'rmdir';
    until: string;
    /** Holds once the step has run, not before it. */
    isAfter?: boolean;
  }

  /**
   * Two writers at a log that reached its limit, each step given held the
   * first time a writer takes it: the moments two writers rotating at once
   * collide. The first writer starts alone and reaches the first hold; the
   * second starts then. Answers both runs once both are done.
   */
  async function twoWritersHeldAt(...holds: Hold[]): Promise<Run[]> {
    const bin = join(data, 'bin');
    mkdirSync(bin, { recursive: true });
    const only = { wc: '', mv: `${log()}.1`, rmdir: `${log()}.lock` };
    for (const hold of holds) {
      const real = spawnSync('bash', ['-c', `command -v ${hold.step}`], { encoding: 'utf8' }).stdout.trim();
      writeFileSync(
        join(bin, hold.step),
        [
          '#!/usr/bin/env bash',
          // mv and rmdir also serve the turn marker: hold only those of the move aside.
          only[hold.step] === '' ? '' : `[ "\${*: -1}" = "${only[hold.step]}" ] || exec ${real} "$@"`,
          `if mkdir "${join(data, `held-${hold.step}`)}" 2>/dev/null; then`,
          hold.isAfter === true ? `  ${real} "$@"; status=$?` : '',
          '  for _ in $(seq 500); do',
          `    ${hold.until} && break`,
          '    sleep 0.01',
          '  done',
          hold.isAfter === true ? '  exit "$status"' : '',
          'fi',
          `exec ${real} "$@"`,
          '',
        ].join('\n'),
      );
      chmodSync(join(bin, hold.step), 0o755);
    }
    const aWriter = () =>
      start('aeolus-turn.sh', {
        stdin: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' }),
        env: { AEOLUS_LOG_MAX_BYTES: '1000', PATH: `${bin}:${process.env.PATH ?? ''}` },
      });
    const firstHeld = join(data, `held-${holds[0]?.step ?? 'wc'}`);

    const first = aWriter();
    await expect.poll(() => statSync(firstHeld, { throwIfNoEntry: false }) !== undefined).toBe(true);
    const second = aWriter();
    const runs = await Promise.all([first.done, second.done]);

    expect(runs.map((done) => done.status)).toEqual([0, 0]);
    return runs;
  }

  /** The records both logs hold after the filler a test started the log with. */
  function recordsAfter(older: string) {
    return `${(read(previous()) ?? '').slice(older.length)}${read(log()) ?? ''}`
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => readLogLine(line));
  }

  const twoTurns = [
    { shipId: SHIP_ID, action: 'turn' },
    { shipId: SHIP_ID, action: 'turn' },
  ];

  it('moves the log aside once when a writer found it at the limit while another moved it aside, and loses no record', async () => {
    crew();
    const older = aLogOf(1000);

    await twoWritersHeldAt({ step: 'wc', until: until.aRecordWritten() });

    expect(read(previous())?.startsWith(older)).toBe(true);
    expect(recordsAfter(older)).toMatchObject(twoTurns);
  });

  it('moves the log aside once when a writer reaches the limit while another is moving it aside, and loses no record', async () => {
    crew();
    const older = aLogOf(1000);

    await twoWritersHeldAt({ step: 'mv', until: until.aRecordWritten() });

    expect(read(previous())?.startsWith(older)).toBe(true);
    expect(recordsAfter(older)).toMatchObject(twoTurns);
  });

  it('prints nothing when a writer finds the log it found at the limit already moved aside by another', async () => {
    crew();
    const older = aLogOf(1000);

    const runs = await twoWritersHeldAt(
      { step: 'wc', until: until.theLogMovedAside() },
      { step: 'rmdir', until: until.aRecordWritten(), isAfter: true },
    );

    expect(runs.map((done) => done.stderr)).toEqual(['', '']);
    expect(read(previous())).toBe(older);
    expect(recordsAfter(older)).toMatchObject(twoTurns);
  });

  it('caps the log at 1 MiB by default', () => {
    crew();
    aLogOf(MIB);

    aPromptSubmitted();

    expect(statSync(previous()).size).toBe(MIB);
    expect(statSync(log()).size).toBeLessThan(1000);
  });

  it('keeps appending to a log one byte under 1 MiB by default', () => {
    crew();
    aLogOf(MIB - 1);

    aPromptSubmitted();

    expect(read(previous())).toBeUndefined();
    expect(statSync(log()).size).toBeGreaterThan(MIB);
  });
});

describe("where a folder's identity lives (#658)", () => {
  /** The crews folder of Claude Code sessions in the throwaway home. */
  const crews = () => join(home, '.aeolus', 'crews', 'claude-code');
  /** The name the plugin gives a folder's identity file: the start of the SHA-256 of the folder's path. */
  const identityName = () => `${createHash('sha256').update(realpathSync(folder)).digest('hex').slice(0, 32)}.identity`;
  const anIdentity = `fleetUrl=https://fleet.example.com\nshipId=${SHIP_ID}\nshipName=scout\ncrewToken=${CREW_TOKEN}\nfolder=/somewhere\n`;

  /** A session crewed by a plugin from before #658: its identity and turn marker in the plugin's data folder. */
  function anOldLayout(): void {
    mkdirSync(join(data, 'ships'), { mode: 0o700 });
    writeFileSync(join(data, 'ships', identityName()), anIdentity, { mode: 0o600 });
    writeFileSync(join(data, 'ships', identityName().replace(/\.identity$/, '.turn')), 'idle 2026-10-11T10:00:00Z\n');
  }

  /** The next session start, as Claude Code runs the hook. */
  function aSessionStart() {
    return run('aeolus-session-start.sh', {
      stdin: JSON.stringify({ session_id: 'c5858406-be86-46cd-8591-f4fb39b1fa61', cwd: folder, hook_event_name: 'SessionStart', source: 'startup' }),
      env: { AEOLUS_FOLDER: '', AEOLUS_DATA: '', CLAUDE_PROJECT_DIR: folder, CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: '/plugin' },
    });
  }

  it("keeps it in ~/.aeolus/crews/claude-code, outside the plugin's data folder", () => {
    crew();

    expect(identityFile()).toBe(join(crews(), identityName()));
    expect(readFileSync(join(crews(), identityName()), 'utf8')).toContain(`crewToken=${CREW_TOKEN}\n`);
  });

  it('keeps the crews folder readable by its owner only', () => {
    crew();

    expect(statSync(crews()).mode & 0o777).toBe(0o700);
  });

  it('keeps it in the folder AEOLUS_CREWS names, as the trierarch names it', () => {
    const named = join(home, 'named-crews');

    expect(run('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', SHIP_ID, 'scout', CREW_TOKEN], env: { AEOLUS_CREWS: named } }).status).toBe(0);

    expect(readFileSync(join(named, identityName()), 'utf8')).toContain(`crewToken=${CREW_TOKEN}\n`);
  });

  it('moves the identities of a session on the old layout to ~/.aeolus/crews/claude-code at the next session start', () => {
    anOldLayout();

    aSessionStart();

    expect(readFileSync(join(crews(), identityName()), 'utf8')).toBe(anIdentity);
    expect(readFileSync(join(crews(), identityName().replace(/\.identity$/, '.turn')), 'utf8')).toBe('idle 2026-10-11T10:00:00Z\n');
  });

  it('tells the session after the move which ship its folder crews', () => {
    anOldLayout();

    expect(aSessionStart().stdout).toContain(`This folder crews the Aeolus ship scout (${SHIP_ID})`);
  });

  it('leaves a link at the old place, so a session on an older plugin still finds the identity there', () => {
    anOldLayout();

    aSessionStart();

    expect(lstatSync(join(data, 'ships')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(data, 'ships'))).toBe(crews());
    expect(readFileSync(join(data, 'ships', identityName()), 'utf8')).toBe(anIdentity);
  });

  it('keeps the identity already in ~/.aeolus/crews when the old place holds one for the same folder', () => {
    crew();
    rmSync(join(data, 'ships'), { force: true });
    anOldLayout();
    writeFileSync(join(data, 'ships', identityName()), anIdentity.replace(CREW_TOKEN, 'aeolus_ct_v1_older'));

    aSessionStart();

    expect(readFileSync(join(crews(), identityName()), 'utf8')).toContain(`crewToken=${CREW_TOKEN}\n`);
  });

  it('moves nothing the next time: a session start after the move keeps the link and the identity', () => {
    anOldLayout();
    aSessionStart();

    aSessionStart();

    expect(lstatSync(join(data, 'ships')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(crews(), identityName()), 'utf8')).toBe(anIdentity);
    expect(dirname(identityFile())).toBe(crews());
  });
});

describe('no plugin script prints a shell error for an optional file that is missing', () => {
  /**
   * Every script, run as a session or a hook runs it, in a folder whose
   * watcher, wake bridge, turn marker, waiting count, report time, model and
   * log were never written.
   */
  const scripts: readonly (readonly string[])[] = [
    ['aeolus-identity.sh', 'show'],
    ['aeolus-identity.sh', 'turn'],
    ['aeolus-identity.sh', 'path'],
    ['aeolus-watch-status.sh'],
    ['aeolus-status.sh'],
    ['aeolus-report-due.sh'],
    ['aeolus-model.sh'],
    ['aeolus-fleet.sh', 'whoami'],
    ['aeolus-fleet.sh', 'send', '-'],
    ['aeolus-inbox.sh'],
    ['aeolus-wait.sh'],
    ['aeolus-watch-guard.sh'],
    ['aeolus-turn.sh'],
    ['aeolus-stop.sh'],
    ['aeolus-session-start.sh'],
    ['aeolus-codex-wake.sh', 'start', 'thread-1'],
    ['aeolus-identity.sh', 'delete'],
  ];
  const payload = () => JSON.stringify({ hook_event_name: 'Stop', cwd: folder, model: 'claude-opus-5-5', tool_input: { command: 'ls' } });
  const aShellErrorForAMissingFile = /No such file or directory|cannot open/;

  async function stderrOfEach(): Promise<string[]> {
    const errors: string[] = [];
    for (const [script = '', ...args] of scripts) {
      const { stderr } = await start(script, { args, stdin: payload(), env: { AEOLUS_MAX_SECONDS: '1' } }).done;
      errors.push(`${script} ${args.join(' ')}: ${stderr}`);
    }
    return errors;
  }

  it('in a folder that crews no ship', async () => {
    const errors = await stderrOfEach();

    expect(errors.filter((error) => aShellErrorForAMissingFile.test(error))).toEqual([]);
  });

  it('in a folder that crews a ship', async () => {
    fleet = await startStubFleet([{ status: 200, body: { waiting: 1, deliveries: [] } }]);
    crew(fleet.url);

    const errors = await stderrOfEach();

    expect(errors.filter((error) => aShellErrorForAMissingFile.test(error))).toEqual([]);
  });
});

/**
 * The env to run a script with, so that the file vanishes right after the
 * script first looks at it with [ ]: the race a single read must survive.
 * Looking for the harness whose crews folder holds the identity only asks
 * whether it is there, so that look leaves the file in place.
 */
function vanishingAfterItsCheck(file: string): Record<string, string> {
  const shim = join(data, 'vanish.sh');
  writeFileSync(
    shim,
    '[() { builtin [ "$@"; local status=$? arg; builtin [ "${FUNCNAME[1]:-}" = aeolus_harness ] && return "$status"; for arg in "$@"; do if builtin [ "$arg" = "$AEOLUS_TEST_VANISH" ]; then rm -f "$arg"; fi; done; return "$status"; }\n',
  );
  return { BASH_ENV: shim, AEOLUS_TEST_VANISH: file };
}

/** A file beside the folder's identity: its name with another suffix. */
const sibling = (suffix: string) => identityFile().replace(/\.identity$/, suffix);

describe('no plugin script prints a shell error for a file that vanishes between its check and its read (#688)', () => {
  const aShellErrorForAMissingFile = /No such file or directory|cannot open/;

  it("the watcher's waiting count", async () => {
    fleet = await startStubFleet([inbox(1)]);
    crew(fleet.url);
    const waitingFile = sibling('.waiting');
    writeFileSync(waitingFile, '1 0\n');

    const { stderr } = await start('aeolus-wait.sh', { env: { AEOLUS_MAX_SECONDS: '1', ...vanishingAfterItsCheck(waitingFile) } }).done;

    expect(stderr).not.toMatch(aShellErrorForAMissingFile);
  });

  it("the watcher's pid, asked whether a watcher runs", () => {
    crew();
    writeFileSync(pidFile(), '12345\n');

    expect(run('aeolus-watch-status.sh', { env: vanishingAfterItsCheck(pidFile()) }).stderr).not.toMatch(aShellErrorForAMissingFile);
  });

  it("the watcher's pid, when the ship is forgotten", () => {
    crew();
    writeFileSync(pidFile(), '12345\n');

    expect(run('aeolus-identity.sh', { args: ['delete'], env: vanishingAfterItsCheck(pidFile()) }).stderr).not.toMatch(aShellErrorForAMissingFile);
  });

  it("the wake bridge's pid, when the ship is forgotten", () => {
    crew();
    writeFileSync(wakePidFile(), '12345\n');

    expect(run('aeolus-identity.sh', { args: ['delete'], env: vanishingAfterItsCheck(wakePidFile()) }).stderr).not.toMatch(aShellErrorForAMissingFile);
  });

  it("a squadron member's report time", () => {
    run('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', SHIP_ID, 'tester-k3x9', CREW_TOKEN, 'team-one'] });
    run('aeolus-identity.sh', { args: ['check-in', '30m'] });
    const reportedFile = sibling('.reported');
    writeFileSync(reportedFile, `${String(Math.floor(Date.now() / 1000))}\n`);

    const result = run('aeolus-report-due.sh', {
      stdin: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/tmp/x' } }),
      env: vanishingAfterItsCheck(reportedFile),
    });

    expect(result.stderr).not.toMatch(aShellErrorForAMissingFile);
  });

  it('the model a send states', async () => {
    fleet = await startStubFleet([{ status: 200, body: { messageId: 'msg_1' } }]);
    crew(fleet.url);
    const modelFile = sibling('.model');
    writeFileSync(modelFile, 'gpt-5.5\n');

    const { stderr } = await start('aeolus-fleet.sh', { args: ['send', '-'], stdin: '{"payload":"hello"}\n', env: vanishingAfterItsCheck(modelFile) }).done;

    expect(stderr).not.toMatch(aShellErrorForAMissingFile);
  });
});

describe('no plugin script prints a shell error for a file that vanishes between its check and its read (#707)', () => {
  const aShellErrorForAMissingFile = /No such file or directory|cannot open/;
  const THREAD_ID = '01a103c9-80b0-7ab1-82e3-6f4a2f70ad86';

  /** A codex on PATH that queues nothing; the env to run the wake bridge with it. */
  function aCodex(): Record<string, string> {
    const bin = join(data, 'bin');
    mkdirSync(bin, { recursive: true });
    const codex = join(bin, 'codex');
    writeFileSync(codex, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(codex, 0o700);
    return { PATH: `${bin}:${process.env.PATH ?? ''}` };
  }

  /** Runs a hook as Claude Code does, with the env added. */
  function claudeHookWith(script: string, { payload, env }: { payload: Record<string, unknown>; env: Record<string, string> }) {
    return run(script, {
      stdin: JSON.stringify({ session_id: 'c5858406-be86-46cd-8591-f4fb39b1fa61', cwd: folder, ...payload }),
      env: { AEOLUS_FOLDER: '', AEOLUS_DATA: '', CLAUDE_PROJECT_DIR: folder, CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: '/plugin', ...env },
    });
  }

  /** Runs one function of aeolus-lib.sh, as the scripts that source it do. */
  function inTheLibrary(call: string, env: Record<string, string>): Run {
    const result = spawnSync('bash', ['-c', `. "${join(SCRIPTS, 'aeolus-lib.sh')}"; ${call}`], {
      encoding: 'utf8',
      env: scriptEnvironment({ HOME: home, AEOLUS_FOLDER: folder, AEOLUS_DATA: data, ...env }),
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('the turn marker, asked whether the session is idle', async () => {
    fleet = await startStubFleet([inbox(0), inbox(1)]);
    crew(fleet.url);
    aTurnEnded();

    const { stderr } = await start('aeolus-wait.sh', { env: { AEOLUS_MAX_SECONDS: '1', ...vanishingAfterItsCheck(sibling('.turn')) } }).done;

    expect(stderr).not.toMatch(aShellErrorForAMissingFile);
  });

  it('the turn marker, when the plugin shows it', () => {
    crew();
    aTurnEnded();

    expect(turn(vanishingAfterItsCheck(sibling('.turn'))).stderr).not.toMatch(aShellErrorForAMissingFile);
  });

  it("the wake bridge's pid, when a bridge is armed", () => {
    crew('http://127.0.0.1:1');
    writeFileSync(wakePidFile(), '12345\n');

    const { stderr } = run('aeolus-codex-wake.sh', { args: ['start', THREAD_ID], env: { ...aCodex(), ...vanishingAfterItsCheck(wakePidFile()) } });

    expect(stderr).not.toMatch(aShellErrorForAMissingFile);
  });

  it("the wake bridge's pid, when the bridge ends", async () => {
    fleet = await startStubFleet([inbox(1)]);
    crew(fleet.url);
    aTurnEnded();

    const { stderr } = await start('aeolus-codex-wake.sh', { args: ['run', THREAD_ID], env: { ...aCodex(), ...vanishingAfterItsCheck(wakePidFile()) } }).done;

    expect(stderr).not.toMatch(aShellErrorForAMissingFile);
  });

  describe('the identity', () => {
    it('when the plugin shows the ship', () => {
      crew();

      expect(run('aeolus-identity.sh', { args: ['show'], env: vanishingAfterItsCheck(identityFile()) }).stderr).not.toMatch(aShellErrorForAMissingFile);
    });

    it('when a fleet call is made', async () => {
      fleet = await startStubFleet([{ status: 200, body: { name: 'scout' } }]);
      crew(fleet.url);

      const { stderr } = await start('aeolus-fleet.sh', { args: ['whoami'], env: vanishingAfterItsCheck(identityFile()) }).done;

      expect(stderr).not.toMatch(aShellErrorForAMissingFile);
    });

    it('when the inbox is checked', async () => {
      fleet = await startStubFleet([inbox(0)]);
      crew(fleet.url);

      const { stderr } = await start('aeolus-inbox.sh', { env: vanishingAfterItsCheck(identityFile()) }).done;

      expect(stderr).not.toMatch(aShellErrorForAMissingFile);
    });

    it('when the watcher starts', async () => {
      fleet = await startStubFleet([inbox(0)]);
      crew(fleet.url);

      const { stderr } = await start('aeolus-wait.sh', { env: { AEOLUS_MAX_SECONDS: '1', ...vanishingAfterItsCheck(identityFile()) } }).done;

      expect(stderr).not.toMatch(aShellErrorForAMissingFile);
    });

    it('when the wake bridge is armed', () => {
      crew('http://127.0.0.1:1');

      const { stderr } = run('aeolus-codex-wake.sh', { args: ['start', THREAD_ID], env: { ...aCodex(), ...vanishingAfterItsCheck(identityFile()) } });

      expect(stderr).not.toMatch(aShellErrorForAMissingFile);
    });

    it('when the SessionStart hook tells a Claude Code session its ship', () => {
      crew();
      const envFile = join(data, 'session.env');
      writeFileSync(envFile, '');

      const { stderr } = claudeHookWith('aeolus-session-start.sh', {
        payload: { hook_event_name: 'SessionStart', source: 'startup' },
        env: { CLAUDE_ENV_FILE: envFile, ...vanishingAfterItsCheck(identityFile()) },
      });

      expect(stderr).not.toMatch(aShellErrorForAMissingFile);
    });

    it('when the SessionStart hook tells a Codex session its ship', () => {
      crew('https://fleet.example.com', AS_CODEX);

      const { stderr } = run('aeolus-session-start.sh', {
        stdin: JSON.stringify({ session_id: THREAD_ID, cwd: folder, hook_event_name: 'SessionStart', source: 'startup' }),
        env: {
          AEOLUS_FOLDER: '',
          AEOLUS_DATA: '',
          CLAUDE_PROJECT_DIR: '',
          PLUGIN_DATA: data,
          PLUGIN_ROOT: SCRIPTS.replace(/\/scripts\/$/, ''),
          AEOLUS_CODEX_WAKE_DISABLED: '1',
          ...vanishingAfterItsCheck(identityFile(AS_CODEX)),
        },
      });

      expect(stderr).not.toMatch(aShellErrorForAMissingFile);
    });

    it('when the Stop hook ends the turn', () => {
      crew();

      const { stderr } = claudeHookWith('aeolus-stop.sh', { payload: { hook_event_name: 'Stop', stop_hook_active: false }, env: vanishingAfterItsCheck(identityFile()) });

      expect(stderr).not.toMatch(aShellErrorForAMissingFile);
    });

    it('when the watcher guard refuses a second watcher', () => {
      crew();
      const watcher = aRunningWatcher();

      try {
        const { stderr } = claudeHookWith('aeolus-watch-guard.sh', {
          payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: '"/plugin/scripts/aeolus-wait.sh"', run_in_background: true } },
          env: vanishingAfterItsCheck(identityFile()),
        });

        expect(stderr).not.toMatch(aShellErrorForAMissingFile);
      } finally {
        watcher.kill();
      }
    });

    it("when a squadron member's report is due", () => {
      run('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', SHIP_ID, 'tester-k3x9', CREW_TOKEN, 'team-one'] });
      run('aeolus-identity.sh', { args: ['check-in', '30m'] });

      const { stderr } = claudeHookWith('aeolus-report-due.sh', {
        payload: { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/tmp/x' } },
        env: vanishingAfterItsCheck(identityFile()),
      });

      expect(stderr).not.toMatch(aShellErrorForAMissingFile);
    });

    it("when the plugin's log records what a ship did", () => {
      crew();

      const { stderr } = inTheLibrary(`aeolus_log "${identityFile()}" turn 'busy: a prompt was submitted'`, vanishingAfterItsCheck(identityFile()));

      expect(stderr).not.toMatch(aShellErrorForAMissingFile);
    });

    it('when the crew token it holds now is asked for', () => {
      crew();

      const { stderr } = inTheLibrary(`aeolus_identity_token "${identityFile()}"`, vanishingAfterItsCheck(identityFile()));

      expect(stderr).not.toMatch(aShellErrorForAMissingFile);
    });
  });
});

describe('the plugin reads the identity once, never looking for it first (#719)', () => {
  it('a squadron member keeping its check-in interval keeps its ship', () => {
    crew();

    run('aeolus-identity.sh', { args: ['check-in', '30m'], env: vanishingAfterItsCheck(identityFile()) });

    expect(run('aeolus-identity.sh', { args: ['show'] }).stdout).toBe(
      `ship: scout (${SHIP_ID})\nfleet: https://fleet.example.com\nfolder: ${folder}\ncheck-in: 30m\n`,
    );
  });

  it('the turn hook marking a turn busy leaves the identity in place', () => {
    crew();

    run('aeolus-turn.sh', {
      stdin: JSON.stringify({ session_id: 'c5858406-be86-46cd-8591-f4fb39b1fa61', cwd: folder, hook_event_name: 'UserPromptSubmit', prompt: 'hello' }),
      env: { AEOLUS_FOLDER: '', AEOLUS_DATA: '', CLAUDE_PROJECT_DIR: folder, CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: '/plugin', ...vanishingAfterItsCheck(identityFile()) },
    });

    expect(run('aeolus-identity.sh', { args: ['show'] }).stdout).toMatch(/^ship: scout /);
  });

  it('register in a folder that already crews a ship names that ship', () => {
    crew();

    const { status, stdout } = run('aeolus-fleet.sh', {
      args: ['register', 'http://127.0.0.1:1', SHIP_ID, 'a-secret', 'DEVICE'],
      env: { AEOLUS_HARNESS: 'claude-code', ...vanishingAfterItsCheck(identityFile()) },
    });

    expect({ status, stdout }).toEqual({
      status: 4,
      stdout: `aeolus: this folder already crews scout (${SHIP_ID}); one folder crews one ship, and deregistering frees it\n`,
    });
  });
});
