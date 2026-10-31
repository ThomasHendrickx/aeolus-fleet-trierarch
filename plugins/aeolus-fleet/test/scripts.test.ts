import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { readLogLine } from '../../../packages/trierarch/src/adapters/log.js';
import { startRoutedStubFleet, startStubFleet, type StubAnswer, type StubFleet } from './stub-fleet.js';
import { scriptEnvironment } from './script-environment.js';

// The aeolus-fleet plugin's bash scripts, as a session runs them: in its folder,
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
  expect(run('aeolus-identity.sh', { args: ['write', fleetUrl, SHIP_ID, 'scout'], stdin: CREW_TOKEN, env }).status).toBe(0);
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

const inbox = (waiting: number, forced = 0) => ({ status: 200, body: { waiting, forced } });

// The hand-over (#756): what the watcher receives and hands to the session.
const DELIVERY_ID = 'dlv_01m4raygfdtsjfbnmpvqjznsyw';
const MESSAGE_ID = 'msg_01m4raygfdtsjfbnmpvqjznsyv';
const PING_DELIVERY_ID = 'dlv_01m4rb0m3d6r4xgnmnhm1k8b2q';
const HANDED_OVER = 'aeolus: a message for scout is handed to this session: it reaches you at your next tool call, or when you end your turn. Do not receive or ack it.\n';
const NO_WAITS = { AEOLUS_BUSY_WAITS: '0 0 0 0' };

/** A delivery as the fleet's receive answers it. */
function aDelivery(overrides: Record<string, unknown> = {}) {
  return {
    deliveryId: DELIVERY_ID,
    messageId: MESSAGE_ID,
    senderShipId: 'shp_01m4ajt7abh4rypkmdnjene67g',
    senderName: 'orchestrator-1',
    senderType: 'orchestrator',
    recipient: { kind: 'ship', shipId: SHIP_ID },
    payload: 'Review "PR 12"\nand say what you found',
    contentType: 'text/plain',
    model: 'claude-opus-5-5',
    inReplyTo: null,
    sentAt: '2026-10-12T15:15:54.467Z',
    attempts: 1,
    ...overrides,
  };
}

/** A second delivery, sent after the first. */
const anotherDelivery = () => aDelivery({ deliveryId: 'dlv_01m4rb7cq8m6d0x3ycsn1f4c2t', messageId: 'msg_01m4rb7cq8m6d0x3ycsn1f4c2s' });
const aPing = () => aDelivery({ deliveryId: PING_DELIVERY_ID, senderName: 'argo', senderType: 'operator', payload: 'ping', contentType: 'application/vnd.aeolus.ping' });
const receiving = (...deliveries: unknown[]): StubAnswer => ({ status: 200, body: { deliveries } });
const acknowledged: StubAnswer = { status: 200, body: {} };
const busy: StubAnswer = { status: 503, body: { code: 'SERVICE_UNAVAILABLE', message: 'The fleet is busy: nothing was stored. Make the same call again.' } };
const notInFlight: StubAnswer = { status: 409, body: { code: 'DELIVERY_NOT_IN_FLIGHT', message: 'Delivery is undeliverable, not in flight' } };
/** A refusal about the delivery whose code the plugin names nowhere: it drops the delivery as it does every delivery refusal. */
const deliveryNotFound: StubAnswer = { status: 404, body: { code: 'DELIVERY_NOT_FOUND', message: 'No delivery with this id' } };
const leaseEnded: StubAnswer = { status: 401, body: { code: 'LEASE_ENDED', message: 'The lease ended' } };
/** The fleet's answer to handed: where the delivery stands now. */
const handedAs = (state: 'handed' | 'acknowledged' | 'undeliverable'): StubAnswer => ({ status: 200, body: { state } });
const handedOk = handedAs('handed');
/** No answer within the hooks' bound: the fleet may have stored the call, but the answer never comes. */
const unanswered: StubAnswer = { status: 200, body: {}, hold: new Promise(() => undefined) };
/** The hooks' bound on a confirmation, short, so an unanswered ack ends soon. */
const SHORT_CONFIRM = { AEOLUS_CONFIRM_SECONDS: '1' };
/** An OK with nothing to say, as turn, handled and notHandled answer. */
const taken: StubAnswer = { status: 200, body: {} };

/** A stub fleet whose inbox answers these counts and whose receive hands these deliveries over, one per call. */
function aWakingFleet(counts: readonly StubAnswer[], receives: readonly StubAnswer[] = [receiving(aDelivery())]): Promise<StubFleet> {
  return startRoutedStubFleet({ '/api/v1/ship/inbox': counts, '/api/v1/ship/pushReceive': receives, '/api/v1/ship/handed': [handedOk], '/api/v1/ship/ack': [acknowledged], '/api/v1/ship/handled': [taken] });
}

const inboxCalls = (stub: StubFleet) => stub.calls.filter((call) => call.path === '/api/v1/ship/inbox');


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
    expect(run('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', SHIP_ID, 'tester-k3x9', 'team-one'], stdin: CREW_TOKEN }).status).toBe(0);

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
      run('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', SHIP_ID, 'lookout'], stdin: 'aeolus_ct_v1_other', env: { AEOLUS_FOLDER: other } });

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
          args: ['write', 'https://fleet.example.com', SHIP_ID, 'scout'], stdin: CREW_TOKEN,
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
    expect(run('aeolus-identity.sh', { args: ['write', '--wake-by', 'trierarch', fleet.url, SHIP_ID, 'scout'], stdin: CREW_TOKEN }).status).toBe(0);

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
    fleet = await aWakingFleet([inbox(0), inbox(0), inbox(2)]);
    crew(fleet.url);
    aTurnEnded();

    const { status, stdout } = await start('aeolus-wait.sh').exited;

    expect(status).toBe(0);
    expect(stdout).toBe(HANDED_OVER);
    expect(inboxCalls(fleet)).toHaveLength(3);
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
    fleet = await startStubFleet([{ ...inbox(1), hold: isLockSeen }, receiving(aDelivery()), handedOk]);
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
      receiving(aDelivery()),
      handedOk,
    ]);
    const stub = fleet;
    crew(stub.url);
    aTurnEnded();
    const watcher = start('aeolus-wait.sh');
    await expect.poll(() => stub.calls.length).toBe(1);
    expect(run('aeolus-identity.sh', { args: ['write', stub.url, SHIP_ID, 'scout'], stdin: 'aeolus_ct_v1_new_crew' }).status).toBe(0);
    answerLeaseEnded();

    await expect(watcher.exited).resolves.toEqual({ status: 0, stdout: HANDED_OVER });
    expect(stub.calls[1]?.authorization).toBe('Bearer aeolus_ct_v1_new_crew');
    expect(readFileSync(identityFile(), 'utf8')).toContain('crewToken=aeolus_ct_v1_new_crew\n');
  });

  it('exits 5 when the fleet refuses the crew token', async () => {
    fleet = await startStubFleet([{ status: 401, body: { code: 'UNAUTHORIZED', message: 'Call with the crew token' } }]);
    crew(fleet.url);

    await expect(start('aeolus-wait.sh').exited).resolves.toMatchObject({ status: 5 });
  });

  it('retries a failing fleet quietly, then exits 0 once deliveries wait', async () => {
    fleet = await startStubFleet([{ status: 500, body: {} }, { status: 503, body: {} }, inbox(1), receiving(aDelivery()), handedOk]);
    crew(fleet.url);
    aTurnEnded();

    await expect(start('aeolus-wait.sh').exited).resolves.toEqual({
      status: 0,
      stdout: HANDED_OVER,
    });
    expect(fleet.calls).toHaveLength(6);
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

describe("the watcher's wake rule: given only when the session is idle", () => {
  it('holds the wake while the session is busy, and gives it once the turn ends', async () => {
    fleet = await aWakingFleet([inbox(1)]);
    const stub = fleet;
    crew(stub.url);
    aPromptSubmitted();
    const watcher = start('aeolus-wait.sh');
    let isExited = false;
    void watcher.exited.then(() => {
      isExited = true;
    });

    await expect.poll(() => inboxCalls(stub).length).toBeGreaterThanOrEqual(3);
    expect(isExited).toBe(false);
    claudeHook('aeolus-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false });

    await expect(watcher.exited).resolves.toEqual({ status: 0, stdout: HANDED_OVER });
  });

  it('wakes no session that has not ended a turn yet', async () => {
    fleet = await aWakingFleet([inbox(1)]);
    const stub = fleet;
    crew(stub.url);
    const watcher = start('aeolus-wait.sh');
    let isExited = false;
    void watcher.exited.then(() => {
      isExited = true;
    });

    try {
      await expect.poll(() => inboxCalls(stub).length).toBeGreaterThanOrEqual(3);
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
    fleet = await aWakingFleet([inbox(1)]);
    crew(fleet.url);
    aTurnEnded();

    await start('aeolus-wait.sh').exited;

    expect(turn().stdout).toMatch(/^busy /);
  });

  it('keeps a wake it held for a busy session when it is started again', async () => {
    fleet = await aWakingFleet([inbox(1)]);
    crew(fleet.url);
    aPromptSubmitted();
    await expect(start('aeolus-wait.sh', { env: { AEOLUS_MAX_SECONDS: '1' } }).exited).resolves.toMatchObject({ status: 6 });
    aTurnEnded();

    await expect(start('aeolus-wait.sh').exited).resolves.toEqual({ status: 0, stdout: HANDED_OVER });
  });

  it('forgets what it saw with the ship', async () => {
    fleet = await aWakingFleet([inbox(1)]);
    crew(fleet.url);
    aTurnEnded();
    await start('aeolus-wait.sh').exited;

    run('aeolus-identity.sh', { args: ['delete'] });

    expect(readdirSync(data, { recursive: true }).map(String).filter((name) => name.startsWith('ships/'))).toEqual([]);
  });
});

describe('the hand-over (#756): the watcher receives one delivery, and the hooks acknowledge it before they put it into the turn', () => {
  const MESSAGE =
    'aeolus: a message for scout from orchestrator-1 (orchestrator): message msg_01m4raygfdtsjfbnmpvqjznsyv, text/plain. ' +
    'The plugin acknowledged it for you: do not receive or ack it. ' +
    'Answer it, if it needs an answer, by sending to orchestrator-1 with inReplyTo msg_01m4raygfdtsjfbnmpvqjznsyv.\n\n' +
    'Review "PR 12"\nand say what you found';
  const DENIED = 'aeolus: this tool call did not run: a message came in first. Read it, then go on, and make the call again if you still need it.\n\n';
  const PING = `aeolus: a ping for scout from argo (delivery ${PING_DELIVERY_ID}): answer it with "/plugin/scripts/aeolus-fleet.sh" pong ${PING_DELIVERY_ID}, and do not act on it or reply.`;
  const START_THE_WATCHER = '\n\naeolus: no watcher runs for scout: when you are done, start "/plugin/scripts/aeolus-wait.sh" as a background task (run_in_background), then end your turn';

  /** The reason a PreToolUse hook denied the tool call with. */
  const deniedWith = (hookRun: Run) =>
    z.object({ hookSpecificOutput: z.object({ permissionDecisionReason: z.string() }) }).parse(JSON.parse(hookRun.stdout)).hookSpecificOutput.permissionDecisionReason;
  const theTurnEnding = (env: Record<string, string> = {}) => aHook('aeolus-stop.sh', { payload: { hook_event_name: 'Stop', stop_hook_active: false }, env });
  /** The turn ends and the Stop hook lets it end, beside the stub fleet the hook may call. */
  const aTurnEnds = () => aHook('aeolus-stop.sh', { payload: { hook_event_name: 'Stop', stop_hook_active: true } });

  /** What the store holds: each entry's delivery id and state, oldest first. */
  function store(): string[] {
    const shown = run('aeolus-identity.sh', { args: ['store'] });
    expect(shown.status).toBe(0);
    return shown.stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.split(' ').slice(0, 2).join(' '));
  }

  /** The watcher hands one delivery over: the fleet's receive answers it while the session is idle. */
  async function aHandOver(routes: Record<string, readonly StubAnswer[]>): Promise<StubFleet> {
    fleet = await startRoutedStubFleet({
      '/api/v1/ship/inbox': [inbox(1)],
      '/api/v1/ship/pushReceive': [receiving(aDelivery())],
      '/api/v1/ship/handed': [handedOk],
      '/api/v1/ship/handled': [taken],
      ...routes,
    });
    crew(fleet.url);
    aTurnEnded();
    await expect(start('aeolus-wait.sh').exited).resolves.toEqual({ status: 0, stdout: HANDED_OVER });
    return fleet;
  }

  const callsTo = (stub: StubFleet, path: string) => stub.calls.filter((call) => call.path === path);

  describe('the watcher', () => {
    it('push-receives one delivery when deliveries wait and the session is idle, keeps it in the store as handed, and says so without its content', async () => {
      const stub = await aHandOver({});

      expect(callsTo(stub, '/api/v1/ship/pushReceive')).toEqual([
        { method: 'POST', path: '/api/v1/ship/pushReceive', authorization: `Bearer ${CREW_TOKEN}`, body: '{"max":1}' },
      ]);
      expect(callsTo(stub, '/api/v1/ship/receive')).toEqual([]);
      expect(store()).toEqual([`${DELIVERY_ID} handed`]);
    });

    it('reports the hand-over to the fleet with its number, 1 for the first, before it says so', async () => {
      const stub = await aHandOver({});

      expect(callsTo(stub, '/api/v1/ship/handed').map((call) => call.body)).toEqual([`{"deliveryId":"${DELIVERY_ID}","handOverNumber":1}`]);
    });

    it('hands the next message over whenever one waits while the session is idle, though the count did not rise since the last hand-over', async () => {
      fleet = await aWakingFleet([inbox(1)], [receiving(aDelivery()), receiving(anotherDelivery())]);
      crew(fleet.url);
      aTurnEnded();
      await start('aeolus-wait.sh').exited;
      await aFirstToolCall();
      await aTurnEnds();

      await expect(start('aeolus-wait.sh').exited).resolves.toEqual({ status: 0, stdout: HANDED_OVER });
      expect(store()).toEqual([`${anotherDelivery().deliveryId} handed`]);
    });

    it('marks the turn busy when it hands a message over, as a wake does', async () => {
      await aHandOver({});

      expect(turn().stdout).toMatch(/^busy /);
    });

    it('reports the turn busy to the fleet as it hands a message over, with the time it marked it', async () => {
      const stub = await aHandOver({ '/api/v1/ship/turn': [taken] });

      const [state, at] = turn().stdout.trim().split(' ');
      expect(callsTo(stub, '/api/v1/ship/turn').map((call) => call.body)).toEqual([`{"turn":"${state ?? ''}","at":"${at ?? ''}"}`]);
      expect(state).toBe('busy');
    });

    it('keeps watching when the receive hands it nothing, as when another ship of its type took the delivery first', async () => {
      fleet = await startRoutedStubFleet({ '/api/v1/ship/inbox': [inbox(1), inbox(2)], '/api/v1/ship/handed': [handedOk], '/api/v1/ship/pushReceive': [receiving(), receiving(aDelivery())] });
      crew(fleet.url);
      aTurnEnded();

      await expect(start('aeolus-wait.sh').exited).resolves.toEqual({ status: 0, stdout: HANDED_OVER });
      expect(callsTo(fleet, '/api/v1/ship/pushReceive')).toHaveLength(2);
    });

    it('hands a message a failed confirmation left received over again at the next idle, with the next number, without receiving it again', async () => {
      const stub = await aHandOver({ '/api/v1/ship/ack': [busy] });
      await aFirstToolCall();
      await aTurnEnds();

      await expect(start('aeolus-wait.sh').exited).resolves.toEqual({ status: 0, stdout: HANDED_OVER });
      expect(callsTo(stub, '/api/v1/ship/pushReceive')).toHaveLength(1);
      expect(callsTo(stub, '/api/v1/ship/handed').map((call) => call.body)).toEqual([
        `{"deliveryId":"${DELIVERY_ID}","handOverNumber":1}`,
        `{"deliveryId":"${DELIVERY_ID}","handOverNumber":2}`,
      ]);
      expect(store()).toEqual([`${DELIVERY_ID} handed`]);
    });

    it('hands a message over again with the same number after an ack whose answer was lost, so the fleet answers acknowledged if it took the ack (#819)', async () => {
      const stub = await aHandOver({ '/api/v1/ship/ack': [unanswered] });
      await aFirstToolCall(SHORT_CONFIRM);
      await aTurnEnds();

      await expect(start('aeolus-wait.sh').exited).resolves.toEqual({ status: 0, stdout: HANDED_OVER });
      expect(callsTo(stub, '/api/v1/ship/handed').map((call) => call.body)).toEqual([
        `{"deliveryId":"${DELIVERY_ID}","handOverNumber":1}`,
        `{"deliveryId":"${DELIVERY_ID}","handOverNumber":1}`,
      ]);
    });

    it('reports the same number again when the fleet did not take the hand-over, so a lost answer counts no attempt', async () => {
      const stub = await aHandOver({ '/api/v1/ship/handed': [{ status: 500, body: {} }, handedOk] });

      expect(callsTo(stub, '/api/v1/ship/handed').map((call) => call.body)).toEqual([
        `{"deliveryId":"${DELIVERY_ID}","handOverNumber":1}`,
        `{"deliveryId":"${DELIVERY_ID}","handOverNumber":1}`,
      ]);
    });

    it('hands over a message the fleet already holds acknowledged: the answer to its confirmation was lost, and the model has not seen it', async () => {
      await aHandOver({ '/api/v1/ship/handed': [handedAs('acknowledged')] });

      expect(store()).toEqual([`${DELIVERY_ID} handed`]);
    });

    it('counts on from the hand-over number the fleet holds when its store lost the entry', async () => {
      const stub = await aHandOver({ '/api/v1/ship/pushReceive': [receiving({ ...aDelivery(), state: 'handed', handOverNumber: 2 })] });

      expect(callsTo(stub, '/api/v1/ship/handed').map((call) => call.body)).toEqual([`{"deliveryId":"${DELIVERY_ID}","handOverNumber":3}`]);
    });

    it('drops a message the fleet answers undeliverable at its fifth attempt, hands nothing, and watches on', async () => {
      fleet = await startRoutedStubFleet({
        '/api/v1/ship/inbox': [inbox(1)],
        '/api/v1/ship/pushReceive': [receiving(aDelivery()), receiving(anotherDelivery())],
        '/api/v1/ship/handed': [handedAs('undeliverable'), handedOk],
      });
      crew(fleet.url);
      aTurnEnded();

      await expect(start('aeolus-wait.sh').exited).resolves.toEqual({ status: 0, stdout: HANDED_OVER });
      expect(store()).toEqual([`${anotherDelivery().deliveryId} handed`]);
    });

    it('drops a message whose hand-over the fleet refuses with any delivery code, and watches on (#832)', async () => {
      fleet = await startRoutedStubFleet({
        '/api/v1/ship/inbox': [inbox(1)],
        '/api/v1/ship/pushReceive': [receiving(aDelivery()), receiving(anotherDelivery())],
        '/api/v1/ship/handed': [deliveryNotFound, handedOk],
      });
      crew(fleet.url);
      aTurnEnded();

      await expect(start('aeolus-wait.sh').exited).resolves.toEqual({ status: 0, stdout: HANDED_OVER });
      expect(store()).toEqual([`${anotherDelivery().deliveryId} handed`]);
    });

    it('drops a message the fleet no longer holds in flight when it reports the hand-over, and watches on', async () => {
      fleet = await startRoutedStubFleet({
        '/api/v1/ship/inbox': [inbox(1)],
        '/api/v1/ship/pushReceive': [receiving(aDelivery()), receiving(anotherDelivery())],
        '/api/v1/ship/handed': [notInFlight, handedOk],
      });
      crew(fleet.url);
      aTurnEnded();

      await expect(start('aeolus-wait.sh').exited).resolves.toEqual({ status: 0, stdout: HANDED_OVER });
      expect(store()).toEqual([`${anotherDelivery().deliveryId} handed`]);
    });

    it('exits 3 and forgets the ship and its store on LEASE_ENDED at the receive', async () => {
      fleet = await startRoutedStubFleet({ '/api/v1/ship/inbox': [inbox(1)], '/api/v1/ship/pushReceive': [leaseEnded] });
      crew(fleet.url);
      aTurnEnded();

      await expect(start('aeolus-wait.sh').exited).resolves.toMatchObject({ status: 3 });
      expect(run('aeolus-identity.sh', { args: ['show'] }).status).toBe(1);
    });

    it('exits 3 and forgets the ship and its store on LEASE_ENDED at the hand-over', async () => {
      fleet = await startRoutedStubFleet({ '/api/v1/ship/inbox': [inbox(1)], '/api/v1/ship/pushReceive': [receiving(aDelivery())], '/api/v1/ship/handed': [leaseEnded] });
      crew(fleet.url);
      aTurnEnded();

      await expect(start('aeolus-wait.sh').exited).resolves.toMatchObject({ status: 3 });
      expect(readdirSync(dirname(identityFile()))).toEqual([]);
    });

    it('drops the entries of an older lease instead of handing them over: the folder was crewed again (D7)', async () => {
      const stub = await aHandOver({ '/api/v1/ship/ack': [busy] });
      await aFirstToolCall();
      expect(run('aeolus-identity.sh', { args: ['write', stub.url, SHIP_ID, 'scout'], stdin: 'aeolus_ct_v1_new_crew' }).status).toBe(0);
      await aTurnEnds();

      await expect(start('aeolus-wait.sh').exited).resolves.toEqual({ status: 0, stdout: HANDED_OVER });
      expect(callsTo(stub, '/api/v1/ship/pushReceive')).toHaveLength(2);
      expect(callsTo(stub, '/api/v1/ship/handed')[1]).toMatchObject({
        authorization: 'Bearer aeolus_ct_v1_new_crew',
        body: `{"deliveryId":"${DELIVERY_ID}","handOverNumber":1}`,
      });
    });
  });

  describe('the first tool call of the turn (PreToolUse)', () => {
    it('acknowledges a handed message first, then denies the tool call with the message as its reason, so the model reads it before it acts', async () => {
      const stub = await aHandOver({ '/api/v1/ship/ack': [acknowledged] });

      const { status, stdout } = await aFirstToolCall();

      expect(status).toBe(0);
      expect(callsTo(stub, '/api/v1/ship/ack')).toEqual([
        { method: 'POST', path: '/api/v1/ship/ack', authorization: `Bearer ${CREW_TOKEN}`, body: `{"deliveryId":"${DELIVERY_ID}"}` },
      ]);
      expect(JSON.parse(stdout)).toEqual({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: DENIED + MESSAGE },
      });
      expect(store()).toEqual([`${DELIVERY_ID} confirmed`]);
    });

    it('names the message it answers, when it is a reply', async () => {
      fleet = await startRoutedStubFleet({
        '/api/v1/ship/inbox': [inbox(1)],
        '/api/v1/ship/handed': [handedOk], '/api/v1/ship/pushReceive': [receiving(aDelivery({ inReplyTo: 'msg_01m4r9zzzzzzzzzzzzzzzzzzzz' }))],
        '/api/v1/ship/ack': [acknowledged],
      });
      crew(fleet.url);
      aTurnEnded();
      await start('aeolus-wait.sh').exited;

      const reason = deniedWith(await aFirstToolCall());

      expect(reason).toContain('message msg_01m4raygfdtsjfbnmpvqjznsyv, text/plain, in reply to msg_01m4r9zzzzzzzzzzzzzzzzzzzz.');
    });

    it("leaves a handed message unacknowledged at a sub-agent's tool call, whose context is not the session's turn (aeolus-fleet#1016)", async () => {
      const stub = await aHandOver({ '/api/v1/ship/ack': [acknowledged] });

      const hookRun = await aSubAgentToolCall();

      expect({ stdout: hookRun.stdout, acks: callsTo(stub, '/api/v1/ship/ack'), store: store() }).toEqual({ stdout: '', acks: [], store: [`${DELIVERY_ID} handed`] });
    });

    it("puts a handed message into the turn at the session's own tool call after a sub-agent's (aeolus-fleet#1016)", async () => {
      await aHandOver({ '/api/v1/ship/ack': [acknowledged] });
      await aSubAgentToolCall();

      expect(deniedWith(await aFirstToolCall())).toBe(DENIED + MESSAGE);
    });

    it('says nothing and lets the tool call run when nothing is handed', async () => {
      fleet = await startRoutedStubFleet({});
      crew(fleet.url);

      expect(await aFirstToolCall()).toEqual({ status: 0, stdout: '', stderr: '' });
      expect(fleet.calls).toEqual([]);
    });

    it('lets the second tool call run: a confirmed message is put into the turn once', async () => {
      await aHandOver({ '/api/v1/ship/ack': [acknowledged] });
      await aFirstToolCall();

      expect((await aFirstToolCall()).stdout).toBe('');
    });

    it('lets the tool call run and shows nothing while the fleet stays busy, and keeps the message received for the next hand-over', async () => {
      const stub = await aHandOver({ '/api/v1/ship/ack': [busy] });

      expect((await aFirstToolCall()).stdout).toBe('');
      expect(callsTo(stub, '/api/v1/ship/ack')).toHaveLength(5);
      expect(store()).toEqual([`${DELIVERY_ID} received`]);
    });

    it('gives an acknowledgement up after the time it is bounded to, and keeps the message received', async () => {
      await aHandOver({ '/api/v1/ship/ack': [{ status: 200, body: {}, hold: new Promise(() => undefined) }] });
      const before = Date.now();

      expect((await aFirstToolCall({ AEOLUS_CONFIRM_SECONDS: '1' })).stdout).toBe('');
      expect(Date.now() - before).toBeLessThan(5_000);
      expect(store()).toEqual([`${DELIVERY_ID} received`]);
    });

    it('bounds each acknowledgement to 3 seconds unless told otherwise, so the retries end inside a hook\'s time', () => {
      expect(readFileSync(join(SCRIPTS, 'aeolus-lib.sh'), 'utf8')).toContain('AEOLUS_CONFIRM_SECONDS:-3}');
    });

    it('drops a message the fleet no longer holds in flight, and shows nothing', async () => {
      await aHandOver({ '/api/v1/ship/ack': [notInFlight] });

      expect((await aFirstToolCall()).stdout).toBe('');
      expect(store()).toEqual([]);
    });

    it('drops a message whose ack the fleet refuses with any delivery code, and shows nothing (#832)', async () => {
      await aHandOver({ '/api/v1/ship/ack': [deliveryNotFound] });

      expect((await aFirstToolCall()).stdout).toBe('');
      expect(store()).toEqual([]);
    });

    it('drops the store with the ship on LEASE_ENDED, and shows nothing', async () => {
      await aHandOver({ '/api/v1/ship/ack': [leaseEnded] });

      expect((await aFirstToolCall()).stdout).toBe('');
      expect(run('aeolus-identity.sh', { args: ['show'] }).status).toBe(1);
      expect(readdirSync(dirname(identityFile()))).toEqual([]);
    });

    it('puts a message over 10,000 characters in as its first part and the path of a file that holds the whole payload', async () => {
      const payload = `${'x'.repeat(9_000)}${'é'.repeat(3_000)}`;
      fleet = await startRoutedStubFleet({
        '/api/v1/ship/inbox': [inbox(1)],
        '/api/v1/ship/handed': [handedOk], '/api/v1/ship/pushReceive': [receiving(aDelivery({ payload }))],
        '/api/v1/ship/ack': [acknowledged],
      });
      crew(fleet.url);
      aTurnEnded();
      await start('aeolus-wait.sh').exited;

      const reason = deniedWith(await aFirstToolCall());
      const file = /the whole payload is in (.+)\.$/.exec(reason)?.[1] ?? '';

      expect(Buffer.byteLength(reason)).toBeLessThanOrEqual(10_000);
      expect(reason).toContain(`\n\n${'x'.repeat(8_000)}`);
      expect(readFileSync(file, 'utf8')).toBe(payload);
    });

    it('puts a message of 10,000 characters with its heading in whole', async () => {
      const heading = DENIED.length + MESSAGE.length - 'Review "PR 12"\nand say what you found'.length;
      const payload = 'y'.repeat(10_000 - heading);
      fleet = await startRoutedStubFleet({
        '/api/v1/ship/inbox': [inbox(1)],
        '/api/v1/ship/handed': [handedOk], '/api/v1/ship/pushReceive': [receiving(aDelivery({ payload }))],
        '/api/v1/ship/ack': [acknowledged],
      });
      crew(fleet.url);
      aTurnEnded();
      await start('aeolus-wait.sh').exited;

      const reason = deniedWith(await aFirstToolCall());

      expect(reason).toHaveLength(10_000);
      expect(reason.endsWith(payload)).toBe(true);
    });

    it('hands a ping over without acknowledging it, asking for pong, so the pong proves the model read it', async () => {
      fleet = await startRoutedStubFleet({ '/api/v1/ship/inbox': [inbox(1)], '/api/v1/ship/handed': [handedOk], '/api/v1/ship/pushReceive': [receiving(aPing())] });
      crew(fleet.url);
      aTurnEnded();
      await start('aeolus-wait.sh').exited;

      const reason = deniedWith(await aFirstToolCall());

      expect(reason).toBe(DENIED + PING);
      expect(callsTo(fleet, '/api/v1/ship/ack')).toEqual([]);
    });
  });

  describe('a delivery of a meeting (decision 0061)', () => {
    const MEETING_ID = 'mtg_01m5qbm1q6rsy6gf15c9w4a8s5';
    const inTheMeeting = (overrides: Record<string, unknown> = {}) => aDelivery({ meetingId: MEETING_ID, recipient: { kind: 'meeting', meetingId: MEETING_ID }, ...overrides });
    const handedOver = async (delivery: unknown) => {
      await aHandOver({ '/api/v1/ship/pushReceive': [receiving(delivery)], '/api/v1/ship/ack': [acknowledged] });
      const ended = z.object({ reason: z.string() }).parse(JSON.parse((await theTurnEnding()).stdout));
      return ended.reason.replace(START_THE_WATCHER, '');
    };

    it('has a contribution answered in the meeting, never with inReplyTo, only with the mic, and the turn ended when there is nothing to request', async () => {
      expect(await handedOver(inTheMeeting())).toBe(
        `aeolus: a message for scout from orchestrator-1 (orchestrator): message ${MESSAGE_ID}, text/plain, in meeting ${MEETING_ID}. ` +
          'The plugin acknowledged it for you: do not receive or ack it. ' +
          `It is for every participant: contribute to the meeting by sending to {"kind":"meeting","meetingId":"${MEETING_ID}"}, never with inReplyTo, and only while you hold the mic or moderate it. ` +
          `To speak, request the mic with "/plugin/scripts/aeolus-fleet.sh" requestMic '{"meetingId":"${MEETING_ID}"}' and contribute once the mic notice comes. ` +
          'Not holding the mic and with nothing to request, end your turn.\n\n' +
          'Review "PR 12"\nand say what you found',
      );
    });

    it('tells the session it was added to a meeting as it tells a contribution: speak only with the mic', async () => {
      const added = await handedOver(inTheMeeting({ contentType: 'application/vnd.aeolus.meeting.added+json', payload: '{}' }));

      expect(added).toContain(`application/vnd.aeolus.meeting.added+json, in meeting ${MEETING_ID}.`);
      expect(added).toContain('Not holding the mic and with nothing to request, end your turn.');
    });

    it('tells the session of the mic notice that it holds the mic: contribute, never with inReplyTo, then release it', async () => {
      expect(await handedOver(inTheMeeting({ contentType: 'application/vnd.aeolus.meeting.mic+json', payload: '{}' }))).toBe(
        `aeolus: a message for scout from orchestrator-1 (orchestrator): message ${MESSAGE_ID}, application/vnd.aeolus.meeting.mic+json, in meeting ${MEETING_ID}. ` +
          'The plugin acknowledged it for you: do not receive or ack it. ' +
          `You hold the mic: contribute by sending to {"kind":"meeting","meetingId":"${MEETING_ID}"}, never with inReplyTo, ` +
          `then release it with "/plugin/scripts/aeolus-fleet.sh" releaseMic '{"meetingId":"${MEETING_ID}"}'.\n\n{}`,
      );
    });

    it('tells the session of the ended notice to contribute no more', async () => {
      expect(await handedOver(inTheMeeting({ contentType: 'application/vnd.aeolus.meeting.ended+json', payload: '{}' }))).toBe(
        `aeolus: a message for scout from orchestrator-1 (orchestrator): message ${MESSAGE_ID}, application/vnd.aeolus.meeting.ended+json, in meeting ${MEETING_ID}. ` +
          'The plugin acknowledged it for you: do not receive or ack it. The meeting ended: contribute no more.\n\n{}',
      );
    });

    it('has a delivery outside a meeting answered by its sender, as before', async () => {
      expect(await handedOver(aDelivery({ meetingId: null }))).toBe(MESSAGE);
    });
  });

  describe('the end of the turn (Stop)', () => {
    it('acknowledges a message still handed when the turn ends without a tool call, and keeps the turn open with it, asking for the watcher', async () => {
      await aHandOver({ '/api/v1/ship/ack': [acknowledged] });

      expect(JSON.parse((await theTurnEnding()).stdout)).toEqual({ decision: 'block', reason: MESSAGE + START_THE_WATCHER });
      expect(store()).toEqual([`${DELIVERY_ID} confirmed`]);
      expect(turn().stdout).toMatch(/^busy /);
    });

    it('asks for no watcher with the message while one runs', async () => {
      await aHandOver({ '/api/v1/ship/ack': [acknowledged] });
      const watcher = aRunningWatcher();

      try {
        expect(JSON.parse((await theTurnEnding()).stdout)).toEqual({ decision: 'block', reason: MESSAGE });
      } finally {
        watcher.kill();
      }
    });

    it('ends a confirmed message as handled once it lets the turn end: reports it handled to the fleet, and drops it', async () => {
      const stub = await aHandOver({ '/api/v1/ship/ack': [acknowledged], '/api/v1/ship/handled': [taken] });
      await aFirstToolCall();
      const watcher = aRunningWatcher();

      try {
        expect((await theTurnEnding()).stdout).toBe('');
        expect(callsTo(stub, '/api/v1/ship/handled')).toEqual([
          { method: 'POST', path: '/api/v1/ship/handled', authorization: `Bearer ${CREW_TOKEN}`, body: `{"deliveryId":"${DELIVERY_ID}"}` },
        ]);
        expect(store()).toEqual([]);
        expect(turn().stdout).toMatch(/^idle /);
      } finally {
        watcher.kill();
      }
    });

    it('reports the turn idle to the fleet once it lets the turn end, with the time it marked it', async () => {
      const stub = await aHandOver({ '/api/v1/ship/ack': [acknowledged], '/api/v1/ship/handled': [taken], '/api/v1/ship/turn': [taken] });
      await aFirstToolCall();

      await aTurnEnds();

      const [state, at] = turn().stdout.trim().split(' ');
      expect(state).toBe('idle');
      expect(callsTo(stub, '/api/v1/ship/turn').map((call) => call.body).at(-1)).toBe(`{"turn":"idle","at":"${at ?? ''}"}`);
    });

    it('keeps a message handled while the fleet does not take the report, and the watcher reports it again', async () => {
      const stub = await aHandOver({ '/api/v1/ship/inbox': [inbox(1), inbox(0)], '/api/v1/ship/ack': [acknowledged], '/api/v1/ship/handled': [{ status: 500, body: {} }, taken] });
      await aFirstToolCall();
      await aTurnEnds();
      expect(store()).toEqual([`${DELIVERY_ID} handled`]);

      await start('aeolus-wait.sh', { env: { AEOLUS_WAIT_SECONDS: '0', AEOLUS_MAX_SECONDS: '1' } }).exited;

      expect(callsTo(stub, '/api/v1/ship/handled')).toHaveLength(2);
      expect(store()).toEqual([]);
    });

    it('sends a turn the fleet did not take again with the next call, keeping the time it was marked', async () => {
      const stub = await aHandOver({
        '/api/v1/ship/inbox': [inbox(1), inbox(0)],
        '/api/v1/ship/ack': [acknowledged],
        '/api/v1/ship/handled': [taken],
        '/api/v1/ship/turn': [taken, { status: 500, body: {} }, taken],
      });
      await aFirstToolCall();
      await aTurnEnds();
      const marked = turn().stdout.trim().split(' ')[1] ?? '';

      await start('aeolus-wait.sh', { env: { AEOLUS_WAIT_SECONDS: '0', AEOLUS_MAX_SECONDS: '1' } }).exited;

      expect(callsTo(stub, '/api/v1/ship/turn').map((call) => call.body).slice(1)).toEqual([
        `{"turn":"idle","at":"${marked}"}`,
        `{"turn":"idle","at":"${marked}"}`,
      ]);
    });

    it('keeps a confirmed message while it keeps the turn open to ask for the watcher', async () => {
      await aHandOver({ '/api/v1/ship/ack': [acknowledged] });
      await aFirstToolCall();

      expect(JSON.parse((await theTurnEnding()).stdout)).toMatchObject({ decision: 'block' });
      expect(store()).toEqual([`${DELIVERY_ID} confirmed`]);
    });

    it('removes the file of a long payload with its message once it is handled', async () => {
      fleet = await startRoutedStubFleet({
        '/api/v1/ship/inbox': [inbox(1)],
        '/api/v1/ship/handed': [handedOk], '/api/v1/ship/pushReceive': [receiving(aDelivery({ payload: 'z'.repeat(12_000) }))],
        '/api/v1/ship/ack': [acknowledged],
        '/api/v1/ship/handled': [taken],
      });
      crew(fleet.url);
      aTurnEnded();
      await start('aeolus-wait.sh').exited;
      const reason = deniedWith(await aFirstToolCall());
      const file = /the whole payload is in (.+)\.$/.exec(reason)?.[1] ?? '';

      await aTurnEnds();

      expect(statSync(file, { throwIfNoEntry: false })).toBeUndefined();
    });

    it('ends a ping answered with pong as handled at the turn end: the fleet takes its handled', async () => {
      fleet = await startRoutedStubFleet({ '/api/v1/ship/inbox': [inbox(1)], '/api/v1/ship/handed': [handedOk], '/api/v1/ship/pushReceive': [receiving(aPing())], '/api/v1/ship/pong': [acknowledged], '/api/v1/ship/handled': [taken] });
      crew(fleet.url);
      aTurnEnded();
      await start('aeolus-wait.sh').exited;
      await aFirstToolCall();
      expect((await start('aeolus-fleet.sh', { args: ['pong', PING_DELIVERY_ID] }).done).status).toBe(0);

      await aTurnEnds();

      expect(callsTo(fleet, '/api/v1/ship/handled').map((call) => call.body)).toEqual([`{"deliveryId":"${PING_DELIVERY_ID}"}`]);
      expect(store()).toEqual([]);
    });

    it('takes a ping not answered with pong back to received at the turn end, to be handed again: the fleet refuses its handled', async () => {
      fleet = await startRoutedStubFleet({
        '/api/v1/ship/inbox': [inbox(1)],
        '/api/v1/ship/handed': [handedOk],
        '/api/v1/ship/pushReceive': [receiving(aPing())],
        '/api/v1/ship/handled': [{ status: 409, body: { code: 'DELIVERY_NOT_ACKNOWLEDGED', message: 'Delivery is handed, not acknowledged' } }],
      });
      crew(fleet.url);
      aTurnEnded();
      await start('aeolus-wait.sh').exited;
      await aFirstToolCall();

      aTurnEnded();

      expect(store()).toEqual([`${PING_DELIVERY_ID} received`]);
    });

    it('acknowledges in a folder a trierarch crews too, for a line that landed mid-turn', async () => {
      await aHandOver({ '/api/v1/ship/ack': [acknowledged] });
      const text = readFileSync(identityFile(), 'utf8');
      writeFileSync(identityFile(), `${text}wakeBy=trierarch\n`);

      expect(JSON.parse((await theTurnEnding()).stdout)).toEqual({ decision: 'block', reason: MESSAGE });
    });
  });

  describe('the prompt that starts a turn (UserPromptSubmit)', () => {
    const ONCE_MORE = 'aeolus: handed before: the turn that took this message ended before it did, so it comes in once more.\n\n';
    const aPrompt = () => aHook('aeolus-turn.sh', { payload: { hook_event_name: 'UserPromptSubmit', prompt: 'go on' } });
    const aTurnFails = () => aHook('aeolus-turn-died.sh', { payload: { hook_event_name: 'StopFailure', error: 'rate_limit' } });
    /** The context a UserPromptSubmit hook added to the turn, or nothing. */
    const contextOf = (hookRun: Run) =>
      hookRun.stdout === ''
        ? ''
        : z.object({ hookSpecificOutput: z.object({ hookEventName: z.literal('UserPromptSubmit'), additionalContext: z.string() }) }).parse(JSON.parse(hookRun.stdout))
            .hookSpecificOutput.additionalContext;
    const handedBodies = (stub: StubFleet) => callsTo(stub, '/api/v1/ship/handed').map((call) => call.body);
    const DELIVERY = `{"deliveryId":"${DELIVERY_ID}"}`;

    it('acknowledges a handed message first, then adds it to the context of the turn the prompt starts', async () => {
      const stub = await aHandOver({ '/api/v1/ship/ack': [acknowledged] });

      const prompted = await aPrompt();

      expect(callsTo(stub, '/api/v1/ship/ack').map((call) => call.body)).toEqual([DELIVERY]);
      expect(JSON.parse(prompted.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: MESSAGE } });
      expect(store()).toEqual([`${DELIVERY_ID} confirmed`]);
    });

    it('adds nothing while the fleet refuses the acknowledgement, and keeps the message received for the next hand-over', async () => {
      await aHandOver({ '/api/v1/ship/ack': [busy] });

      expect((await aPrompt()).stdout).toBe('');
      expect(store()).toEqual([`${DELIVERY_ID} received`]);
    });

    it('reports the turn busy to the fleet, with the time it marked it', async () => {
      const stub = await aHandOver({ '/api/v1/ship/ack': [acknowledged], '/api/v1/ship/turn': [taken] });
      await aFirstToolCall();
      await aTurnEnds();

      await aPrompt();

      const [state, at] = turn().stdout.trim().split(' ');
      expect(state).toBe('busy');
      expect(callsTo(stub, '/api/v1/ship/turn').map((call) => call.body).at(-1)).toBe(`{"turn":"busy","at":"${at ?? ''}"}`);
    });

    it('reports a confirmed message handled when its turn ends, though prompts were injected into that turn mid-turn (#846)', async () => {
      const stub = await aHandOver({ '/api/v1/ship/ack': [acknowledged], '/api/v1/ship/notHandled': [taken] });
      await aFirstToolCall();
      await aPrompt();
      await aPrompt();
      await aPrompt();
      await aPrompt();

      await aTurnEnds();

      expect(handedBodies(stub)).toEqual([`{"deliveryId":"${DELIVERY_ID}","handOverNumber":1}`]);
      expect(callsTo(stub, '/api/v1/ship/notHandled')).toEqual([]);
      expect(callsTo(stub, '/api/v1/ship/handled').map((call) => call.body)).toEqual([DELIVERY]);
      expect(store()).toEqual([]);
    });

    it('puts nothing into the turn for a prompt injected into it mid-turn, and keeps the confirmed message as it is (#846)', async () => {
      await aHandOver({ '/api/v1/ship/ack': [acknowledged] });
      await aFirstToolCall();

      const prompted = await aPrompt();

      expect(prompted.stdout).toBe('');
      expect(store()).toEqual([`${DELIVERY_ID} confirmed`]);
    });

    it('reports a message handed once more handled when the turn it was put into ends, though prompts were injected into it mid-turn (#846)', async () => {
      const stub = await aHandOver({ '/api/v1/ship/ack': [acknowledged], '/api/v1/ship/handed': [handedOk, handedAs('acknowledged')], '/api/v1/ship/notHandled': [taken] });
      await aFirstToolCall();
      await aTurnFails();
      expect(contextOf(await aPrompt())).toBe(ONCE_MORE + MESSAGE);
      await aPrompt();

      await aTurnEnds();

      expect(callsTo(stub, '/api/v1/ship/notHandled')).toEqual([]);
      expect(callsTo(stub, '/api/v1/ship/handled').map((call) => call.body)).toEqual([DELIVERY]);
      expect(store()).toEqual([]);
    });

    it('drops a message the fleet refuses to hand once more, and puts nothing in', async () => {
      await aHandOver({
        '/api/v1/ship/ack': [acknowledged],
        '/api/v1/ship/handed': [handedOk, { status: 409, body: { code: 'DELIVERY_HANDED_ONCE_MORE', message: 'Delivery was handed once more already' } }],
      });
      await aFirstToolCall();
      await aTurnFails();

      expect((await aPrompt()).stdout).toBe('');
      expect(store()).toEqual([]);
    });
  });

  describe('a turn that fails (StopFailure)', () => {
    const aTurnFails = () => aHook('aeolus-turn-died.sh', { payload: { hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: 'API Error: Rate limit reached' } });
    const aPrompt = () => aHook('aeolus-turn.sh', { payload: { hook_event_name: 'UserPromptSubmit', prompt: 'go on' } });

    it('keeps a confirmed message to hand once more at the next prompt, says nothing, and reports the turn idle (D3)', async () => {
      const stub = await aHandOver({ '/api/v1/ship/ack': [acknowledged], '/api/v1/ship/turn': [taken] });
      await aFirstToolCall();

      const failed = await aTurnFails();

      expect(failed).toEqual({ status: 0, stdout: '', stderr: '' });
      expect(store()).toEqual([`${DELIVERY_ID} onceMore`]);
      const [state, at] = turn().stdout.trim().split(' ');
      expect(state).toBe('idle');
      expect(callsTo(stub, '/api/v1/ship/turn').map((call) => call.body).at(-1)).toBe(`{"turn":"idle","at":"${at ?? ''}"}`);
      expect(callsTo(stub, '/api/v1/ship/handled')).toEqual([]);
    });

    it('lets the next prompt put the message in once more', async () => {
      const stub = await aHandOver({ '/api/v1/ship/ack': [acknowledged], '/api/v1/ship/handed': [handedOk, handedAs('acknowledged')] });
      await aFirstToolCall();
      await aTurnFails();

      const prompted = await aPrompt();

      expect(callsTo(stub, '/api/v1/ship/handed').map((call) => call.body).at(-1)).toBe(`{"deliveryId":"${DELIVERY_ID}","handOverNumber":2,"isOnceMore":true}`);
      expect(prompted.stdout).toContain('aeolus: handed before');
      expect(store()).toEqual([`${DELIVERY_ID} onceMore`]);
    });

    it('reports a message not handled when the turn it was handed once more to fails too, and drops it', async () => {
      const stub = await aHandOver({ '/api/v1/ship/ack': [acknowledged], '/api/v1/ship/handed': [handedOk, handedAs('acknowledged')], '/api/v1/ship/notHandled': [taken] });
      await aFirstToolCall();
      await aTurnFails();
      await aPrompt();

      await aTurnFails();

      expect(callsTo(stub, '/api/v1/ship/notHandled').map((call) => call.body)).toEqual([`{"deliveryId":"${DELIVERY_ID}","reason":"the turn it was handed once more to died too (StopFailure: rate_limit)"}`]);
      expect(store()).toEqual([]);
    });

    it('sends a reason the fleet takes: one line of at most 200 characters, however long the error of the failed turn (#847)', async () => {
      const stub = await aHandOver({ '/api/v1/ship/ack': [acknowledged], '/api/v1/ship/handed': [handedOk, handedAs('acknowledged')], '/api/v1/ship/notHandled': [taken] });
      const aLongFailure = () => aHook('aeolus-turn-died.sh', { payload: { hook_event_name: 'StopFailure', error: `overloaded\n${'x'.repeat(300)}` } });
      await aFirstToolCall();
      await aLongFailure();
      await aPrompt();

      await aLongFailure();

      const [body] = callsTo(stub, '/api/v1/ship/notHandled').map((call) => z.object({ reason: z.string() }).parse(JSON.parse(call.body)));
      expect(body?.reason).toHaveLength(200);
      expect(body?.reason).toMatch(/^the turn it was handed once more to died too \(StopFailure: overloaded x+$/);
    });

    it('sends a not handled report the fleet did not take again with the next call, with its reason (#847)', async () => {
      const stub = await aHandOver({ '/api/v1/ship/ack': [acknowledged], '/api/v1/ship/handed': [handedOk, handedAs('acknowledged')], '/api/v1/ship/notHandled': [busy, taken] });
      await aFirstToolCall();
      await aTurnFails();
      await aPrompt();
      await aTurnFails();

      await aPrompt();

      const reported = `{"deliveryId":"${DELIVERY_ID}","reason":"the turn it was handed once more to died too (StopFailure: rate_limit)"}`;
      expect(callsTo(stub, '/api/v1/ship/notHandled').map((call) => call.body).at(-1)).toBe(reported);
      expect(store()).toEqual([]);
    });

    it('does nothing in a folder that crews no ship', async () => {
      expect(await aTurnFails()).toEqual({ status: 0, stdout: '', stderr: '' });
    });
  });

  describe('a session started again by a person (SessionStart on startup or resume, D6)', () => {
    const aSessionStart = (source: string) => aHook('aeolus-session-start.sh', { payload: { hook_event_name: 'SessionStart', source } });
    const aPrompt = () => aHook('aeolus-turn.sh', { payload: { hook_event_name: 'UserPromptSubmit', prompt: 'hello again' } });
    const handedBodies = (stub: StubFleet) => callsTo(stub, '/api/v1/ship/handed').map((call) => call.body);
    const handedNumber = (number: number) => `{"deliveryId":"${DELIVERY_ID}","handOverNumber":${String(number)}}`;

    it('reports a handed message the session never took handed again with the next number, and the first prompt confirms it', async () => {
      const stub = await aHandOver({ '/api/v1/ship/ack': [acknowledged] });

      await aSessionStart('startup');

      expect(handedBodies(stub)).toEqual([handedNumber(1), handedNumber(2)]);
      expect(store()).toEqual([`${DELIVERY_ID} handed`]);
      expect(JSON.parse((await aPrompt()).stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: MESSAGE } });
      expect(store()).toEqual([`${DELIVERY_ID} confirmed`]);
    });

    it('reports a message whose confirmation failed handed with the next number at resume', async () => {
      const stub = await aHandOver({ '/api/v1/ship/ack': [busy] });
      await aFirstToolCall();

      await aSessionStart('resume');

      expect(handedBodies(stub)).toEqual([handedNumber(1), handedNumber(2)]);
      expect(store()).toEqual([`${DELIVERY_ID} handed`]);
    });

    it('reports a message whose ack went unanswered handed with the same number at startup, so the fleet answers acknowledged if it took the ack (#819)', async () => {
      const stub = await aHandOver({ '/api/v1/ship/ack': [unanswered] });
      await aFirstToolCall(SHORT_CONFIRM);

      await aSessionStart('startup');

      expect(handedBodies(stub)).toEqual([handedNumber(1), handedNumber(1)]);
    });

    it('keeps a confirmed message whose session died to hand once more, and the first prompt puts it in as handed before', async () => {
      const stub = await aHandOver({ '/api/v1/ship/ack': [acknowledged], '/api/v1/ship/handed': [handedOk, handedAs('acknowledged')] });
      await aFirstToolCall();

      await aSessionStart('startup');

      expect(store()).toEqual([`${DELIVERY_ID} onceMore`]);
      expect(handedBodies(stub)).toEqual([handedNumber(1)]);
      expect((await aPrompt()).stdout).toContain('aeolus: handed before');
      expect(handedBodies(stub).at(-1)).toBe(`{"deliveryId":"${DELIVERY_ID}","handOverNumber":2,"isOnceMore":true}`);
    });

    it('reports a message handed once more not handled when its session died too, and drops it', async () => {
      const stub = await aHandOver({ '/api/v1/ship/ack': [acknowledged], '/api/v1/ship/handed': [handedOk, handedAs('acknowledged')], '/api/v1/ship/notHandled': [taken] });
      await aFirstToolCall();
      await aHook('aeolus-turn-died.sh', { payload: { hook_event_name: 'StopFailure', error: 'rate_limit' } });
      await aPrompt();

      await aSessionStart('startup');

      expect(callsTo(stub, '/api/v1/ship/notHandled').map((call) => call.body)).toEqual([`{"deliveryId":"${DELIVERY_ID}","reason":"the session it was handed once more to died too (SessionStart: startup)"}`]);
      expect(store()).toEqual([]);
    });

    it('drops a message the fleet answers undeliverable at its fifth attempt', async () => {
      await aHandOver({ '/api/v1/ship/handed': [handedOk, handedAs('undeliverable')] });

      await aSessionStart('startup');

      expect(store()).toEqual([]);
    });

    it('marks nothing after /clear or a compact: the session did not die', async () => {
      const stub = await aHandOver({ '/api/v1/ship/ack': [acknowledged] });
      await aFirstToolCall();

      await aSessionStart('clear');
      await aSessionStart('compact');

      expect(handedBodies(stub)).toEqual([handedNumber(1)]);
      expect(store()).toEqual([`${DELIVERY_ID} confirmed`]);
    });

    it('marks nothing in a folder a trierarch crews: the trierarch hands over there', async () => {
      const stub = await aHandOver({});
      writeFileSync(identityFile(), `${readFileSync(identityFile(), 'utf8')}wakeBy=trierarch\n`);

      await aSessionStart('startup');

      expect(handedBodies(stub)).toEqual([handedNumber(1)]);
    });
  });

  describe('in Codex: the wake bridge hands a message over, and the prompt it queues confirms it (2b, Codex)', () => {
    const THREAD_ID = '01a103c9-80b0-7ab1-82e3-6f4a2f70ad86';
    const QUEUED =
      "Aeolus handed a message for scout to this task: it comes into this turn through the plugin's hooks, acknowledged. " +
      'Do not receive or ack it. Handle it as the aeolus-fleet-crew skill says, then re-arm automatic wake-up before ending the turn.';

    /** Runs a hook as Codex does: PLUGIN_ROOT and PLUGIN_DATA set, the task id in the payload, no Claude Code variables. */
    const aCodexHook = (script: string, payload: Record<string, unknown>) =>
      start(script, {
        stdin: JSON.stringify({ session_id: THREAD_ID, turn_id: 'turn-1', cwd: folder, model: 'gpt-5.5', ...payload }),
        env: {
          AEOLUS_FOLDER: '',
          AEOLUS_DATA: '',
          CLAUDE_PROJECT_DIR: '',
          CLAUDE_PLUGIN_DATA: '',
          CLAUDE_PLUGIN_ROOT: '',
          PLUGIN_DATA: data,
          PLUGIN_ROOT: SCRIPTS.replace(/\/scripts\/$/, ''),
          AEOLUS_CODEX_WAKE_DISABLED: '1',
          ...NO_WAITS,
        },
      }).done;

    /** The Codex task's turn ends, and the Stop hook lets it end. */
    const aCodexTurnEnds = () => aCodexHook('aeolus-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' });

    /** The wake bridge runs once for the task, with a codex on PATH that writes down what it queues. */
    async function aCodexHandOver(routes: Record<string, readonly StubAnswer[]>) {
      fleet = await startRoutedStubFleet({
        '/api/v1/ship/inbox': [inbox(1)],
        '/api/v1/ship/pushReceive': [receiving(aDelivery())],
        '/api/v1/ship/handed': [handedOk],
        '/api/v1/ship/handled': [taken],
        ...routes,
      });
      crew(fleet.url, AS_CODEX);
      await aCodexTurnEnds();
      const codex = aCodex();
      await expect(start('aeolus-codex-wake.sh', { args: ['run', THREAD_ID], env: { ...AS_CODEX, ...codex.env } }).exited).resolves.toMatchObject({ status: 0 });
      return { stub: fleet, queued: () => readFileSync(codex.calls, 'utf8') };
    }

    describe('the wake bridge', () => {
      it('push-receives one delivery while the task is idle, reports it handed with its number and keeps it in the store as handed', async () => {
        const { stub } = await aCodexHandOver({});

        expect(callsTo(stub, '/api/v1/ship/pushReceive').map((call) => call.body)).toEqual(['{"max":1}']);
        expect(callsTo(stub, '/api/v1/ship/receive')).toEqual([]);
        expect(callsTo(stub, '/api/v1/ship/handed').map((call) => call.body)).toEqual([`{"deliveryId":"${DELIVERY_ID}","handOverNumber":1}`]);
        expect(store()).toEqual([`${DELIVERY_ID} handed`]);
      });

      it('queues one prompt to the task, saying the message comes into that turn through the hooks, without its content', async () => {
        const { queued } = await aCodexHandOver({});

        expect(queued()).toBe(`queue --thread ${THREAD_ID} --message ${QUEUED}\n`);
        expect(actions().at(-1)).toEqual({ ...scout, action: 'wakeBridge', outcome: `queued a hand-over of ${DELIVERY_ID} to Codex task ${THREAD_ID}` });
      });
    });

    describe('the queued prompt (UserPromptSubmit)', () => {
      const theQueuedPrompt = () => aCodexHook('aeolus-turn.sh', { hook_event_name: 'UserPromptSubmit', prompt: QUEUED });

      it('acknowledges the handed message first, then adds it to the context of the turn the prompt starts', async () => {
        const { stub } = await aCodexHandOver({ '/api/v1/ship/ack': [acknowledged] });

        const prompted = await theQueuedPrompt();

        expect(callsTo(stub, '/api/v1/ship/ack')).toEqual([
          { method: 'POST', path: '/api/v1/ship/ack', authorization: `Bearer ${CREW_TOKEN}`, body: `{"deliveryId":"${DELIVERY_ID}"}` },
        ]);
        expect(JSON.parse(prompted.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: MESSAGE } });
        expect(store()).toEqual([`${DELIVERY_ID} confirmed`]);
      });

      it('adds nothing while the fleet refuses the acknowledgement, and keeps the message received for the next hand-over', async () => {
        await aCodexHandOver({ '/api/v1/ship/ack': [busy] });

        expect((await theQueuedPrompt()).stdout).toBe('');
        expect(store()).toEqual([`${DELIVERY_ID} received`]);
      });

      it('puts a ping in without an acknowledgement: its pong confirms it', async () => {
        const { stub } = await aCodexHandOver({ '/api/v1/ship/pushReceive': [receiving(aPing())] });

        const prompted = await theQueuedPrompt();

        expect(callsTo(stub, '/api/v1/ship/ack')).toEqual([]);
        expect(JSON.parse(prompted.stdout)).toEqual({
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: PING.replace('"/plugin/scripts/', `"${SCRIPTS}`),
          },
        });
      });

      it('reports the turn busy to the fleet, with the time it marked it', async () => {
        const { stub } = await aCodexHandOver({ '/api/v1/ship/ack': [acknowledged], '/api/v1/ship/turn': [taken] });
        await theQueuedPrompt();
        await aCodexTurnEnds();

        await aCodexHook('aeolus-turn.sh', { hook_event_name: 'UserPromptSubmit', prompt: 'go on' });

        const [state, at] = turn(AS_CODEX).stdout.trim().split(' ');
        expect(state).toBe('busy');
        const reported = callsTo(stub, '/api/v1/ship/turn').map((call) => call.body);
        // The watcher's busy and the queued prompt's are one report when they fall in the same second, else two.
        expect(reported.map((body) => z.object({ turn: z.string() }).parse(JSON.parse(body)).turn).slice(-2)).toEqual(['idle', 'busy']);
        expect(reported.at(-1)).toBe(`{"turn":"busy","at":"${at ?? ''}"}`);
      });
    });

    describe('the end of the turn (Stop)', () => {
      it('reports the message the turn took handled, drops it and says nothing', async () => {
        const { stub } = await aCodexHandOver({ '/api/v1/ship/ack': [acknowledged] });
        await aCodexHook('aeolus-turn.sh', { hook_event_name: 'UserPromptSubmit', prompt: QUEUED });

        expect((await aCodexTurnEnds()).stdout).toBe('');
        expect(callsTo(stub, '/api/v1/ship/handled').map((call) => call.body)).toEqual([`{"deliveryId":"${DELIVERY_ID}"}`]);
        expect(store()).toEqual([]);
      });

      it('reports the turn idle to the fleet, with the time it marked it', async () => {
        const { stub } = await aCodexHandOver({ '/api/v1/ship/ack': [acknowledged], '/api/v1/ship/turn': [taken] });
        await aCodexHook('aeolus-turn.sh', { hook_event_name: 'UserPromptSubmit', prompt: QUEUED });

        await aCodexTurnEnds();

        const [state, at] = turn(AS_CODEX).stdout.trim().split(' ');
        expect(state).toBe('idle');
        expect(callsTo(stub, '/api/v1/ship/turn').map((call) => call.body).at(-1)).toBe(`{"turn":"idle","at":"${at ?? ''}"}`);
      });
    });

    it('tells a task on a pushed lease at session start that the message comes into the turn through the hooks, not to receive what waits', async () => {
      await aCodexHandOver({});

      const started = await aCodexHook('aeolus-session-start.sh', { hook_event_name: 'SessionStart', source: 'resume' });

      const context = hookOutputSchema.parse(JSON.parse(started.stdout)).hookSpecificOutput.additionalContext;
      expect(context).toContain(
        "Go on as the aeolus-fleet-crew skill says: fetch the protocol. Receive and ack nothing: this ship is pushed, so the wake bridge hands each message over and it comes into the turn through the plugin's hooks. Then end the turn.",
      );
      expect(context).not.toContain('receive and handle what waits');
    });

    describe('an interrupted turn (Interrupt): a died turn (3.7, D3)', () => {
      const ONCE_MORE = 'aeolus: handed before: the turn that took this message ended before it did, so it comes in once more.\n\n';
      const anInterrupt = () => aCodexHook('aeolus-turn-died.sh', { hook_event_name: 'Interrupt', permission_mode: 'default', transcript_path: null });
      const aPrompt = () => aCodexHook('aeolus-turn.sh', { hook_event_name: 'UserPromptSubmit', prompt: 'go on' });

      /** The bridge hands a message over, and the queued prompt confirms it. */
      async function aConfirmedMessage(routes: Record<string, readonly StubAnswer[]>) {
        const { stub } = await aCodexHandOver({ '/api/v1/ship/ack': [acknowledged], '/api/v1/ship/handed': [handedOk, handedAs('acknowledged')], ...routes });
        await aCodexHook('aeolus-turn.sh', { hook_event_name: 'UserPromptSubmit', prompt: QUEUED });
        return stub;
      }

      it('keeps the message the turn took to hand once more at the next prompt, says nothing, and reports the turn idle', async () => {
        const stub = await aConfirmedMessage({ '/api/v1/ship/turn': [taken] });

        expect(await anInterrupt()).toEqual({ status: 0, stdout: '', stderr: '' });
        expect(store()).toEqual([`${DELIVERY_ID} onceMore`]);
        const [state, at] = turn(AS_CODEX).stdout.trim().split(' ');
        expect(state).toBe('idle');
        expect(callsTo(stub, '/api/v1/ship/turn').map((call) => call.body).at(-1)).toBe(`{"turn":"idle","at":"${at ?? ''}"}`);
        expect(callsTo(stub, '/api/v1/ship/handled')).toEqual([]);
      });

      it('lets the next prompt put the message in once more, reported handed once more with the next number', async () => {
        const stub = await aConfirmedMessage({});
        await anInterrupt();

        const prompted = await aPrompt();

        expect(callsTo(stub, '/api/v1/ship/handed').map((call) => call.body).at(-1)).toBe(`{"deliveryId":"${DELIVERY_ID}","handOverNumber":2,"isOnceMore":true}`);
        expect(JSON.parse(prompted.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ONCE_MORE + MESSAGE } });
      });

      it('reports the message the turn took handled when it ends, though prompts were injected into that turn mid-turn (#846)', async () => {
        const stub = await aConfirmedMessage({ '/api/v1/ship/notHandled': [taken] });
        await aPrompt();
        await aPrompt();

        await aCodexTurnEnds();

        expect(callsTo(stub, '/api/v1/ship/handed').map((call) => call.body)).toEqual([`{"deliveryId":"${DELIVERY_ID}","handOverNumber":1}`]);
        expect(callsTo(stub, '/api/v1/ship/notHandled')).toEqual([]);
        expect(callsTo(stub, '/api/v1/ship/handled').map((call) => call.body)).toEqual([`{"deliveryId":"${DELIVERY_ID}"}`]);
        expect(store()).toEqual([]);
      });

      it('keeps the message a task that died without Interrupt took to hand once more at resume, and the first prompt puts it in as handed before (#846)', async () => {
        const stub = await aConfirmedMessage({});

        await aCodexHook('aeolus-session-start.sh', { hook_event_name: 'SessionStart', source: 'resume' });

        expect(store()).toEqual([`${DELIVERY_ID} onceMore`]);
        const prompted = await aPrompt();
        expect(callsTo(stub, '/api/v1/ship/handed').map((call) => call.body).at(-1)).toBe(`{"deliveryId":"${DELIVERY_ID}","handOverNumber":2,"isOnceMore":true}`);
        expect(JSON.parse(prompted.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ONCE_MORE + MESSAGE } });
      });

      it('reports a message handed once more not handled when its task died too and resumes, and drops it (#846)', async () => {
        const stub = await aConfirmedMessage({ '/api/v1/ship/notHandled': [taken] });
        await anInterrupt();
        await aPrompt();

        await aCodexHook('aeolus-session-start.sh', { hook_event_name: 'SessionStart', source: 'resume' });

        expect(callsTo(stub, '/api/v1/ship/notHandled').map((call) => call.body)).toEqual([
          `{"deliveryId":"${DELIVERY_ID}","reason":"the session it was handed once more to died too (SessionStart: resume)"}`,
        ]);
        expect(store()).toEqual([]);
      });

      it('reports the message not handled when the turn it was handed once more to is interrupted too, and drops it', async () => {
        const stub = await aConfirmedMessage({ '/api/v1/ship/notHandled': [taken] });
        await anInterrupt();
        await aPrompt();

        await anInterrupt();

        expect(callsTo(stub, '/api/v1/ship/notHandled').map((call) => call.body)).toEqual([`{"deliveryId":"${DELIVERY_ID}","reason":"the turn it was handed once more to died too (Interrupt)"}`]);
        expect(store()).toEqual([]);
      });
    });
  });

  describe('a folder a trierarch crews, on a lease pushed: the hooks report as they do for a session crewed by hand (slice 8)', () => {
    const aPrompt = () => aHook('aeolus-turn.sh', { payload: { hook_event_name: 'UserPromptSubmit', prompt: 'go on' } });
    const aTurnFails = () => aHook('aeolus-turn-died.sh', { payload: { hook_event_name: 'StopFailure', error: 'rate_limit' } });
    const PUSHED_UNDER_A_TRIERARCH =
      "fetch the protocol. Receive and ack nothing: this ship is pushed, so the trierarch hands each message over and it comes into the turn through the plugin's hooks.";

    /** A message handed over on a pushed lease, in a folder a trierarch crews. */
    async function handedUnderATrierarch(routes: Record<string, readonly StubAnswer[]>): Promise<StubFleet> {
      const stub = await aHandOver({ '/api/v1/ship/ack': [acknowledged], '/api/v1/ship/turn': [taken], ...routes });
      writeFileSync(identityFile(), `${readFileSync(identityFile(), 'utf8')}wakeBy=trierarch\n`);
      stub.calls.length = 0;
      return stub;
    }

    it('reports the turn busy at the prompt that starts it', async () => {
      const stub = await handedUnderATrierarch({});
      await aPrompt();
      await aTurnEnds();
      stub.calls.length = 0;

      await aPrompt();

      const [, at] = turn().stdout.trim().split(' ');
      expect(callsTo(stub, '/api/v1/ship/turn').map((call) => call.body)).toEqual([`{"turn":"busy","at":"${at ?? ''}"}`]);
    });

    it('reports the message the turn took handled when the turn ends, and the turn idle', async () => {
      const stub = await handedUnderATrierarch({});
      await aPrompt();

      await aTurnEnds();

      const [, at] = turn().stdout.trim().split(' ');
      expect(callsTo(stub, '/api/v1/ship/handled').map((call) => call.body)).toEqual([`{"deliveryId":"${DELIVERY_ID}"}`]);
      expect(callsTo(stub, '/api/v1/ship/turn').map((call) => call.body).at(-1)).toBe(`{"turn":"idle","at":"${at ?? ''}"}`);
      expect(store()).toEqual([]);
    });

    it('keeps a confirmed message to hand once more when its turn fails, and the next prompt reports it handed once more and puts it in (D3)', async () => {
      const stub = await handedUnderATrierarch({ '/api/v1/ship/handed': [handedAs('acknowledged')] });
      await aPrompt();
      await aTurnFails();

      const prompted = await aPrompt();

      expect(callsTo(stub, '/api/v1/ship/handed').map((call) => call.body)).toEqual([`{"deliveryId":"${DELIVERY_ID}","handOverNumber":2,"isOnceMore":true}`]);
      expect(prompted.stdout).toContain('aeolus: handed before');
    });

    it('shows the lease pushed', async () => {
      await handedUnderATrierarch({});

      expect(run('aeolus-identity.sh', { args: ['show'] }).stdout).toContain('\ndelivery: pushed\n');
    });

    it('tells a Claude Code session at its start to receive nothing, since the trierarch hands each message over', async () => {
      await handedUnderATrierarch({});

      const context = hookOutputSchema.parse(JSON.parse((await aHook('aeolus-session-start.sh', { payload: { hook_event_name: 'SessionStart', source: 'startup' } })).stdout))
        .hookSpecificOutput.additionalContext;

      expect(context).toContain(PUSHED_UNDER_A_TRIERARCH);
      expect(context).toContain('The trierarch wakes this session when work arrives: start no watcher.');
      expect(context).not.toContain('receive and handle what waits');
    });
  });

  describe('under a trierarch: aeolus-push.sh hands one message over per call, and the trierarch types the line it prints (2a)', () => {
    const HAND_OVER_LINE = "Aeolus handed a message for scout to this session: it comes into this turn through the plugin's hooks, acknowledged. Do not receive or ack it.\n";
    const handedBodies = (stub: StubFleet) => callsTo(stub, '/api/v1/ship/handed').map((call) => call.body);
    const handedNumber = (number: number) => `{"deliveryId":"${DELIVERY_ID}","handOverNumber":${String(number)}}`;
    const aPrompt = () => aHook('aeolus-turn.sh', { payload: { hook_event_name: 'UserPromptSubmit', prompt: 'go on' } });
    const hand = () => start('aeolus-push.sh', { args: ['hand'], env: NO_WAITS }).done;
    const died = () => start('aeolus-push.sh', { args: ['died'], env: NO_WAITS }).done;

    function crewedByATrierarch(fleetUrl: string): void {
      expect(run('aeolus-identity.sh', { args: ['write', '--wake-by', 'trierarch', fleetUrl, SHIP_ID, 'scout'], stdin: CREW_TOKEN }).status).toBe(0);
    }

    /** The trierarch hands one delivery over: the fleet's push receive answers it while the session is idle. */
    async function aTrierarchHandOver(routes: Record<string, readonly StubAnswer[]>): Promise<StubFleet> {
      fleet = await startRoutedStubFleet({
        '/api/v1/ship/pushReceive': [receiving(aDelivery())],
        '/api/v1/ship/handed': [handedOk],
        '/api/v1/ship/handled': [taken],
        '/api/v1/ship/turn': [taken],
        ...routes,
      });
      crewedByATrierarch(fleet.url);
      aTurnEnded();
      expect(await hand()).toMatchObject({ status: 0, stdout: HAND_OVER_LINE });
      return fleet;
    }

    describe('hand', () => {
      it('push-receives one delivery, keeps it in the store as handed, reports it handed with number 1, and prints the line to type', async () => {
        const stub = await aTrierarchHandOver({});

        expect(callsTo(stub, '/api/v1/ship/pushReceive').map((call) => call.body)).toEqual(['{"max":1}']);
        expect(handedBodies(stub)).toEqual([handedNumber(1)]);
        expect(store()).toEqual([`${DELIVERY_ID} handed`]);
      });

      it('marks the turn busy as it hands over, so the next pass hands nothing more', async () => {
        await aTrierarchHandOver({});

        expect(turn().stdout).toMatch(/^busy /);
      });

      it('makes the lease pushed', async () => {
        await aTrierarchHandOver({});

        expect(run('aeolus-identity.sh', { args: ['show'] }).stdout).toContain('\ndelivery: pushed\n');
      });

      it('hands a message whose confirmation failed again with the next number, without receiving it again', async () => {
        const stub = await aTrierarchHandOver({ '/api/v1/ship/ack': [busy] });
        await aPrompt();
        await aTurnEnds();

        expect(await hand()).toMatchObject({ status: 0, stdout: HAND_OVER_LINE });
        expect(callsTo(stub, '/api/v1/ship/pushReceive')).toHaveLength(1);
        expect(handedBodies(stub)).toEqual([handedNumber(1), handedNumber(2)]);
      });

      it('answers 1 and prints nothing when the receive hands nothing over, as when another ship of its type took it first', async () => {
        fleet = await startRoutedStubFleet({ '/api/v1/ship/pushReceive': [receiving()] });
        crewedByATrierarch(fleet.url);
        aTurnEnded();

        expect(await hand()).toMatchObject({ status: 1, stdout: '' });
        expect(turn().stdout).toMatch(/^idle /);
      });

      it('drops a message the fleet answers undeliverable at its fifth attempt and answers 1: nothing is handed (3.18)', async () => {
        fleet = await startRoutedStubFleet({ '/api/v1/ship/pushReceive': [receiving(aDelivery())], '/api/v1/ship/handed': [handedAs('undeliverable')] });
        crewedByATrierarch(fleet.url);
        aTurnEnded();

        expect(await hand()).toMatchObject({ status: 1, stdout: '' });
        expect(store()).toEqual([]);
      });

      it('drops a message the fleet no longer holds in flight and answers 1', async () => {
        fleet = await startRoutedStubFleet({ '/api/v1/ship/pushReceive': [receiving(aDelivery())], '/api/v1/ship/handed': [notInFlight] });
        crewedByATrierarch(fleet.url);
        aTurnEnded();

        expect(await hand()).toMatchObject({ status: 1, stdout: '' });
        expect(store()).toEqual([]);
      });

      it('answers 3 and forgets the store on LEASE_ENDED', async () => {
        const stub = await aTrierarchHandOver({ '/api/v1/ship/ack': [busy] });
        await aPrompt();
        await aTurnEnds();
        stub.calls.length = 0;
        await stub.close();
        fleet = await startRoutedStubFleet({ '/api/v1/ship/handed': [leaseEnded] });
        crewedByATrierarch(fleet.url);

        expect(await hand()).toMatchObject({ status: 3, stdout: '' });
        expect(store()).toEqual([]);
      });

      it('drops the entries of an older lease and receives again: the ship was crewed again (D7)', async () => {
        const stub = await aTrierarchHandOver({ '/api/v1/ship/ack': [busy] });
        await aPrompt();
        expect(run('aeolus-identity.sh', { args: ['write', '--wake-by', 'trierarch', stub.url, SHIP_ID, 'scout'], stdin: 'aeolus_ct_v1_new_crew' }).status).toBe(0);
        await aTurnEnds();

        expect(await hand()).toMatchObject({ status: 0, stdout: HAND_OVER_LINE });
        expect(callsTo(stub, '/api/v1/ship/pushReceive')).toHaveLength(2);
        expect(callsTo(stub, '/api/v1/ship/handed')[1]).toMatchObject({ authorization: 'Bearer aeolus_ct_v1_new_crew', body: handedNumber(1) });
      });

      it('prints the line for a message to hand once more and reports nothing: the prompt it starts reports it', async () => {
        const stub = await aTrierarchHandOver({ '/api/v1/ship/ack': [acknowledged] });
        await aPrompt();
        await died();
        aTurnEnded();

        expect(await hand()).toMatchObject({ status: 0, stdout: HAND_OVER_LINE });
        expect(handedBodies(stub)).toEqual([handedNumber(1)]);
        expect(callsTo(stub, '/api/v1/ship/pushReceive')).toHaveLength(1);
      });

      it('tells a Codex task at its start to receive nothing on the lease it pushed, since the trierarch hands each message over', async () => {
        fleet = await startRoutedStubFleet({ '/api/v1/ship/pushReceive': [receiving(aDelivery())], '/api/v1/ship/handed': [handedOk], '/api/v1/ship/turn': [taken] });
        expect(run('aeolus-identity.sh', { args: ['write', '--wake-by', 'trierarch', fleet.url, SHIP_ID, 'scout'], stdin: CREW_TOKEN, env: AS_CODEX }).status).toBe(0);
        expect((await start('aeolus-push.sh', { args: ['hand'], env: { ...NO_WAITS, ...AS_CODEX } }).done).status).toBe(0);

        const started = run('aeolus-session-start.sh', {
          stdin: JSON.stringify({ session_id: '01a103c9-80b0-7ab1-82e3-6f4a2f70ad86', cwd: folder, hook_event_name: 'SessionStart', source: 'startup' }),
          env: { AEOLUS_FOLDER: '', AEOLUS_DATA: '', CLAUDE_PROJECT_DIR: '', PLUGIN_DATA: data, PLUGIN_ROOT: SCRIPTS.replace(/\/scripts\/$/, '') },
        });

        expect(hookOutputSchema.parse(JSON.parse(started.stdout)).hookSpecificOutput.additionalContext).toContain(
          "Receive and ack nothing: this ship is pushed, so the trierarch hands each message over and it comes into the turn through the plugin's hooks.",
        );
      });

      it('answers 2 in a folder that crews no ship', async () => {
        expect(await hand()).toMatchObject({ status: 2 });
      });
    });

    describe("over the trierarch's socket (decision 0026): the folder holds no crew token, and the hooks still report on its pushed lease", () => {
      let sockets: string;

      beforeEach(() => {
        // Short, under /tmp: a Unix socket path is at most 104 bytes on macOS.
        sockets = mkdtempSync('/tmp/aeolus-sock-');
      });

      afterEach(() => {
        rmSync(sockets, { recursive: true, force: true });
      });

      /** The trierarch hands one delivery over to a folder it crews over its socket. */
      async function aHandOverOverTheSocket(): Promise<StubFleet> {
        const socket = join(sockets, 'fleet.sock');
        fleet = await startRoutedStubFleet(
          { '/api/v1/ship/pushReceive': [receiving(aDelivery())], '/api/v1/ship/handed': [handedOk], '/api/v1/ship/ack': [acknowledged], '/api/v1/ship/handled': [taken], '/api/v1/ship/turn': [taken] },
          { socket },
        );
        expect(run('aeolus-identity.sh', { args: ['write', '--wake-by', 'trierarch', '--socket', socket, fleet.url, SHIP_ID, 'scout'], stdin: CREW_TOKEN }).status).toBe(0);
        aTurnEnded();
        expect(await hand()).toMatchObject({ status: 0, stdout: HAND_OVER_LINE });
        return fleet;
      }

      it('makes the lease pushed', async () => {
        await aHandOverOverTheSocket();

        expect(run('aeolus-identity.sh', { args: ['show'] }).stdout).toContain('\ndelivery: pushed\n');
      });

      it('reports the turn busy at the prompt that starts it', async () => {
        const stub = await aHandOverOverTheSocket();
        await aPrompt();
        await aTurnEnds();
        stub.calls.length = 0;

        await aPrompt();

        const [, at] = turn().stdout.trim().split(' ');
        expect(callsTo(stub, '/api/v1/ship/turn').map((call) => call.body)).toEqual([`{"turn":"busy","at":"${at ?? ''}"}`]);
      });
    });

    describe('died: the session died, before the trierarch starts it again (3.5 to 3.7, 3.10)', () => {
      it('marks the turn busy, as the trierarch starts the session again with a prompt, so no pass hands a message into that turn (#890)', async () => {
        fleet = await startRoutedStubFleet({ '/api/v1/ship/turn': [taken] });
        crewedByATrierarch(fleet.url);
        aTurnEnded();

        await died();

        expect(turn().stdout).toMatch(/^busy /);
      });

      it('keeps a confirmed message to hand once more: its session died after it took it', async () => {
        const stub = await aTrierarchHandOver({ '/api/v1/ship/ack': [acknowledged] });
        await aPrompt();

        expect(await died()).toMatchObject({ status: 0, stdout: '' });
        expect(store()).toEqual([`${DELIVERY_ID} onceMore`]);
        expect(handedBodies(stub)).toEqual([handedNumber(1)]);
      });

      it('reports a handed message the session never took handed again with the next number', async () => {
        const stub = await aTrierarchHandOver({});

        await died();

        expect(handedBodies(stub)).toEqual([handedNumber(1), handedNumber(2)]);
        expect(store()).toEqual([`${DELIVERY_ID} handed`]);
      });

      it('reports a message handed once more not handled when its session died too, and drops it', async () => {
        const stub = await aTrierarchHandOver({ '/api/v1/ship/ack': [acknowledged], '/api/v1/ship/handed': [handedOk, handedAs('acknowledged')], '/api/v1/ship/notHandled': [taken] });
        await aPrompt();
        await died();
        await aPrompt();

        await died();

        expect(callsTo(stub, '/api/v1/ship/notHandled').map((call) => call.body)).toEqual([`{"deliveryId":"${DELIVERY_ID}","reason":"the session it was handed once more to died too (the trierarch starts it again)"}`]);
        expect(store()).toEqual([]);
      });
    });
  });

  describe('a forced message (decision 0040): it comes first, and a busy turn gets it now', () => {
    const FORCED_ID = 'dlv_01m4rbd2k7v3q8x5ycsn1f4c2t';
    const FORCED_MESSAGE_ID = 'msg_01m4rbd2k7v3q8x5ycsn1f4c2s';
    const aForcedDelivery = () => aDelivery({ deliveryId: FORCED_ID, messageId: FORCED_MESSAGE_ID, payload: 'Stop: the release is cancelled', isForced: true });
    const HAND_OVER_LINE = "Aeolus handed a message for scout to this session: it comes into this turn through the plugin's hooks, acknowledged. Do not receive or ack it.\n";
    const handedBodies = (stub: StubFleet) => callsTo(stub, '/api/v1/ship/handed').map((call) => call.body);
    const handledBodies = (stub: StubFleet) => callsTo(stub, '/api/v1/ship/handled').map((call) => call.body);
    const force = (env: Record<string, string> = {}) => start('aeolus-push.sh', { args: ['force'], env: { ...NO_WAITS, ...env } }).done;
    const hand = (env: Record<string, string> = {}) => start('aeolus-push.sh', { args: ['hand'], env: { ...NO_WAITS, ...env } }).done;

    describe('the watcher, for a session crewed by hand in Claude Code', () => {
      it('hands a forced message over while the session is busy, for its next tool call or Stop', async () => {
        fleet = await aWakingFleet([inbox(1, 1)], [receiving(aForcedDelivery())]);
        crew(fleet.url);
        aPromptSubmitted();

        await expect(start('aeolus-wait.sh').exited).resolves.toEqual({ status: 0, stdout: HANDED_OVER });
        expect(store()).toEqual([`${FORCED_ID} handed`]);
      });

      it('lets the next tool call of the busy turn put the forced message in', async () => {
        fleet = await aWakingFleet([inbox(1, 1)], [receiving(aForcedDelivery())]);
        crew(fleet.url);
        aPromptSubmitted();
        await start('aeolus-wait.sh').exited;

        expect(deniedWith(await aFirstToolCall())).toContain('Stop: the release is cancelled');
        expect(callsTo(fleet, '/api/v1/ship/ack').map((call) => call.body)).toEqual([`{"deliveryId":"${FORCED_ID}"}`]);
      });

      it('hands a forced message before one the store holds unconfirmed, while the session is idle', async () => {
        const stub = await aHandOver({ '/api/v1/ship/ack': [busy], '/api/v1/ship/inbox': [inbox(1), inbox(2, 1)], '/api/v1/ship/pushReceive': [receiving(aDelivery()), receiving(aForcedDelivery())] });
        await aFirstToolCall();
        await aTurnEnds();

        await expect(start('aeolus-wait.sh').exited).resolves.toEqual({ status: 0, stdout: HANDED_OVER });
        expect(handedBodies(stub).at(-1)).toBe(`{"deliveryId":"${FORCED_ID}","handOverNumber":1}`);
        expect(store()).toEqual([`${DELIVERY_ID} received`, `${FORCED_ID} handed`]);
      });

      it('keeps a plain message the receive answers instead of the forced one, as when another ship of the type took it first, for the next idle, never into the busy turn (#926)', async () => {
        fleet = await aWakingFleet([inbox(1, 1), inbox(1)], [receiving(aDelivery())]);
        crew(fleet.url);
        aPromptSubmitted();

        await expect(start('aeolus-wait.sh', { env: { AEOLUS_MAX_SECONDS: '3', AEOLUS_POLL_SECONDS: '1' } }).exited).resolves.toMatchObject({ status: 6 });
        expect(callsTo(fleet, '/api/v1/ship/handed')).toEqual([]);
        expect(store()).toEqual([`${DELIVERY_ID} received`]);
      });

      it('holds a forced message while a Codex task is busy: hand-crewed Codex gets it at its next idle', async () => {
        fleet = await aWakingFleet([inbox(1, 1)], [receiving(aForcedDelivery())]);
        const stub = fleet;
        crew(stub.url, AS_CODEX);
        expect(run('aeolus-turn.sh', { stdin: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'go on' }), env: AS_CODEX }).status).toBe(0);

        await expect(start('aeolus-wait.sh', { env: { ...AS_CODEX, AEOLUS_MAX_SECONDS: '1' } }).exited).resolves.toMatchObject({ status: 6 });
        expect(callsTo(stub, '/api/v1/ship/pushReceive')).toEqual([]);
      });
    });

    describe('under a trierarch: aeolus-push.sh force, given while a forced message waits', () => {
      function crewedByATrierarch(fleetUrl: string, env: Record<string, string> = {}): void {
        expect(run('aeolus-identity.sh', { args: ['write', '--wake-by', 'trierarch', fleetUrl, SHIP_ID, 'scout'], stdin: CREW_TOKEN, env }).status).toBe(0);
      }
      const aPrompt = () => aHook('aeolus-turn.sh', { payload: { hook_event_name: 'UserPromptSubmit', prompt: 'go on' } });

      /** The trierarch hands a plain message over, and the prompt its line starts confirms it: the turn is busy with it. */
      async function aBusyTurnWithAMessage(routes: Record<string, readonly StubAnswer[]>): Promise<StubFleet> {
        fleet = await startRoutedStubFleet({
          '/api/v1/ship/pushReceive': [receiving(aDelivery()), receiving(aForcedDelivery())],
          '/api/v1/ship/handed': [handedOk],
          '/api/v1/ship/ack': [acknowledged],
          '/api/v1/ship/handled': [taken],
          '/api/v1/ship/turn': [taken],
          ...routes,
        });
        crewedByATrierarch(fleet.url);
        aTurnEnded();
        expect((await hand()).status).toBe(0);
        await aPrompt();
        return fleet;
      }

      it('push-receives the forced message while the turn is busy, reports it handed with number 1 and prints the line to type', async () => {
        const stub = await aBusyTurnWithAMessage({});

        expect(await force()).toMatchObject({ status: 0, stdout: HAND_OVER_LINE });
        expect(callsTo(stub, '/api/v1/ship/pushReceive')).toHaveLength(2);
        expect(handedBodies(stub).at(-1)).toBe(`{"deliveryId":"${FORCED_ID}","handOverNumber":1}`);
        expect(store()).toEqual([`${DELIVERY_ID} confirmed`, `${FORCED_ID} handed`]);
      });

      it('hands the forced message before one to hand once more', async () => {
        const stub = await aBusyTurnWithAMessage({});
        await start('aeolus-push.sh', { args: ['died'], env: NO_WAITS }).done;
        aTurnEnded();

        expect(await force()).toMatchObject({ status: 0, stdout: HAND_OVER_LINE });
        expect(handedBodies(stub).at(-1)).toBe(`{"deliveryId":"${FORCED_ID}","handOverNumber":1}`);
        expect(store()).toEqual([`${DELIVERY_ID} onceMore`, `${FORCED_ID} handed`]);
      });

      it('keeps a plain message the push receive answers instead of the forced one, as when another ship of the type took it first, and stops no busy turn for it (#926)', async () => {
        fleet = await startRoutedStubFleet({ '/api/v1/ship/pushReceive': [receiving(aDelivery())], '/api/v1/ship/handed': [handedOk] });
        crewedByATrierarch(fleet.url);
        aPromptSubmitted();

        expect(await force()).toMatchObject({ status: 1, stdout: '' });
        expect(handedBodies(fleet)).toEqual([]);
        expect(store()).toEqual([`${DELIVERY_ID} received`]);
      });

      it('hands the plain message it kept at the next idle (#926)', async () => {
        fleet = await startRoutedStubFleet({ '/api/v1/ship/pushReceive': [receiving(aDelivery())], '/api/v1/ship/handed': [handedOk], '/api/v1/ship/turn': [taken] });
        crewedByATrierarch(fleet.url);
        aPromptSubmitted();
        await force();
        aTurnEnded();

        expect(await hand()).toMatchObject({ status: 0, stdout: HAND_OVER_LINE });
        expect(handedBodies(fleet)).toEqual([`{"deliveryId":"${DELIVERY_ID}","handOverNumber":1}`]);
      });

      it('answers 1 and prints nothing when the push receive hands nothing over', async () => {
        fleet = await startRoutedStubFleet({ '/api/v1/ship/pushReceive': [receiving()] });
        crewedByATrierarch(fleet.url);
        aPromptSubmitted();

        expect(await force()).toMatchObject({ status: 1, stdout: '' });
      });

      it('in Claude Code: the forced prompt puts the forced message in, and when the forced turn ends the stopped turn\'s message is handled too', async () => {
        const stub = await aBusyTurnWithAMessage({ '/api/v1/ship/notHandled': [taken] });
        await force();

        const prompted = await aPrompt();
        await aTurnEnds();

        expect(prompted.stdout).toContain('Stop: the release is cancelled');
        expect(handledBodies(stub)).toEqual([`{"deliveryId":"${DELIVERY_ID}"}`, `{"deliveryId":"${FORCED_ID}"}`]);
        expect(callsTo(stub, '/api/v1/ship/notHandled')).toEqual([]);
        expect(handedBodies(stub).filter((body) => body.includes('isOnceMore'))).toEqual([]);
        expect(store()).toEqual([]);
      });

      describe('in Codex, whose stopped turn fires Interrupt: stopping is not dying', () => {
        const aCodexHook = (script: string, payload: Record<string, unknown>) =>
          start(script, {
            stdin: JSON.stringify({ session_id: '01a103c9-80b0-7ab1-82e3-6f4a2f70ad86', turn_id: 'turn-1', cwd: folder, model: 'gpt-5.5', ...payload }),
            env: {
              AEOLUS_FOLDER: '',
              AEOLUS_DATA: '',
              CLAUDE_PROJECT_DIR: '',
              CLAUDE_PLUGIN_DATA: '',
              CLAUDE_PLUGIN_ROOT: '',
              PLUGIN_DATA: data,
              PLUGIN_ROOT: SCRIPTS.replace(/\/scripts\/$/, ''),
              AEOLUS_CODEX_WAKE_DISABLED: '1',
              ...NO_WAITS,
            },
          }).done;
        const anInterrupt = () => aCodexHook('aeolus-turn-died.sh', { hook_event_name: 'Interrupt', permission_mode: 'default', transcript_path: null });
        const aCodexPrompt = () => aCodexHook('aeolus-turn.sh', { hook_event_name: 'UserPromptSubmit', prompt: 'go on' });
        const aCodexTurnEnds = () => aCodexHook('aeolus-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' });

        /** A Codex task a trierarch crews, busy with a confirmed message. */
        async function aBusyCodexTurnWithAMessage(): Promise<StubFleet> {
          fleet = await startRoutedStubFleet({
            '/api/v1/ship/pushReceive': [receiving(aDelivery()), receiving(aForcedDelivery())],
            '/api/v1/ship/handed': [handedOk],
            '/api/v1/ship/ack': [acknowledged],
            '/api/v1/ship/handled': [taken],
            '/api/v1/ship/notHandled': [taken],
            '/api/v1/ship/turn': [taken],
          });
          crewedByATrierarch(fleet.url, AS_CODEX);
          await aCodexTurnEnds();
          expect((await hand(AS_CODEX)).status).toBe(0);
          await aCodexPrompt();
          return fleet;
        }

        it('keeps the stopped turn\'s message confirmed at the Interrupt a forced stop fires, never to hand once more', async () => {
          await aBusyCodexTurnWithAMessage();
          await force(AS_CODEX);

          await anInterrupt();

          expect(store()).toEqual([`${DELIVERY_ID} confirmed`, `${FORCED_ID} handed`]);
        });

        it('handles the stopped turn\'s message when the forced turn ends', async () => {
          const stub = await aBusyCodexTurnWithAMessage();
          await force(AS_CODEX);
          await anInterrupt();

          const prompted = await aCodexPrompt();
          await aCodexTurnEnds();

          expect(prompted.stdout).toContain('Stop: the release is cancelled');
          expect(handledBodies(stub)).toEqual([`{"deliveryId":"${DELIVERY_ID}"}`, `{"deliveryId":"${FORCED_ID}"}`]);
          expect(callsTo(stub, '/api/v1/ship/notHandled')).toEqual([]);
          expect(store()).toEqual([]);
        });

        it('takes an Interrupt of the forced turn itself as a died turn again', async () => {
          await aBusyCodexTurnWithAMessage();
          await force(AS_CODEX);
          await anInterrupt();
          await aCodexPrompt();

          await anInterrupt();

          expect(store()).toEqual([`${DELIVERY_ID} onceMore`, `${FORCED_ID} onceMore`]);
        });
      });
    });
  });

  describe('what a session on a pushed lease is told: the message comes into the turn through the hooks, never by its own receive', () => {
    const PUSHED =
      'Go on as the Aeolus Fleet crew-a-ship skill says: fetch the protocol. Receive and ack nothing: this ship is pushed, so the watcher hands each message over and it comes into the turn through the plugin\'s hooks.';
    const contextAt = async (source: string) =>
      hookOutputSchema.parse(JSON.parse((await aHook('aeolus-session-start.sh', { payload: { hook_event_name: 'SessionStart', source } })).stdout)).hookSpecificOutput.additionalContext;

    it('says so at session start, and not to receive what waits', async () => {
      await aHandOver({});

      const context = await contextAt('clear');

      expect(context).toContain(PUSHED);
      expect(context).not.toContain('receive and handle what waits');
    });

    it('still says to receive what waits on a lease the watcher has not pushed: it pulls', async () => {
      fleet = await startRoutedStubFleet({});
      crew(fleet.url);

      expect(await contextAt('clear')).toContain('receive and handle what waits');
    });

    it('shows the lease pushed', async () => {
      await aHandOver({});

      expect(run('aeolus-identity.sh', { args: ['show'] }).stdout).toContain('\ndelivery: pushed\n');
    });

    it('shows nothing pushed for a lease the watcher has not pushed', () => {
      crew();

      expect(run('aeolus-identity.sh', { args: ['show'] }).stdout).not.toContain('delivery:');
    });
  });

  describe("a session with another ship's AEOLUS_FOLDER in its environment (#884): its hooks refuse it, never acting as the other ship", () => {
    const HOOKS = [
      { script: 'aeolus-session-start.sh', payload: { hook_event_name: 'SessionStart', source: 'startup' } },
      { script: 'aeolus-turn.sh', payload: { hook_event_name: 'UserPromptSubmit', prompt: 'go on' } },
      { script: 'aeolus-handover.sh', payload: { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/tmp/x' } } },
      { script: 'aeolus-stop.sh', payload: { hook_event_name: 'Stop', stop_hook_active: false } },
      { script: 'aeolus-turn-died.sh', payload: { hook_event_name: 'StopFailure', error: 'rate_limit' } },
    ] as const;
    let ownFolder: string;

    beforeEach(() => {
      ownFolder = mkdtempSync(join(tmpdir(), 'aeolus folder "two"-'));
    });

    afterEach(() => {
      rmSync(ownFolder, { recursive: true, force: true });
    });

    /** Runs a hook of the session in its own folder, with the folder of scout, which holds a handed message, inherited as AEOLUS_FOLDER. */
    const aHookWithScoutsFolder = (script: string, payload: Readonly<Record<string, unknown>>) =>
      start(script, {
        stdin: JSON.stringify({ session_id: 'c5858406-be86-46cd-8591-f4fb39b1fa61', cwd: ownFolder, ...payload }),
        env: { AEOLUS_FOLDER: folder, AEOLUS_DATA: '', CLAUDE_PROJECT_DIR: ownFolder, CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: '/plugin', CLAUDE_ENV_FILE: join(data, 'session.env'), ...NO_WAITS },
      }).done;

    it.each(HOOKS)('$payload.hook_event_name stops with an error naming both folders', async ({ script, payload }) => {
      await aHandOver({});

      const hookRun = await aHookWithScoutsFolder(script, payload);

      expect(hookRun.status).toBe(1);
      expect(hookRun.stderr).toContain(`aeolus: refused AEOLUS_FOLDER ${folder}: this session's folder is ${ownFolder}`);
    });

    it.each(HOOKS)('$payload.hook_event_name calls the fleet for no ship, keeps the message of scout where it was and says nothing of scout', async ({ script, payload }) => {
      const stub = await aHandOver({ '/api/v1/ship/ack': [acknowledged], '/api/v1/ship/turn': [taken], '/api/v1/ship/notHandled': [taken] });
      const callsBefore = stub.calls.length;

      const hookRun = await aHookWithScoutsFolder(script, payload);

      expect(stub.calls.length).toBe(callsBefore);
      expect(store()).toEqual([`${DELIVERY_ID} handed`]);
      expect(hookRun.stdout).not.toContain('scout');
    });

    it("exports the session's own folder for its commands at session start, never the inherited one", async () => {
      await aHandOver({});
      writeFileSync(join(data, 'session.env'), '');

      await aHookWithScoutsFolder('aeolus-session-start.sh', { hook_event_name: 'SessionStart', source: 'startup' });

      const exported = spawnSync('bash', ['-c', '. "$1"; printf %s "$AEOLUS_FOLDER"', 'bash', join(data, 'session.env')], { env: { AEOLUS_FOLDER: folder } });
      expect(exported.stdout.toString()).toBe(realpathSync(ownFolder));
    });
  });

  it('reports no turn and nothing handled for a lease the watcher has not pushed: the ship pulls', async () => {
    fleet = await startRoutedStubFleet({});
    crew(fleet.url);

    await aHook('aeolus-turn.sh', { payload: { hook_event_name: 'UserPromptSubmit', prompt: 'hello' } });
    await aTurnEnds();

    expect(fleet.calls).toEqual([]);
  });

  it('forgets the store with the ship', async () => {
    await aHandOver({});

    run('aeolus-identity.sh', { args: ['delete'] });

    expect(readdirSync(dirname(identityFile()))).toEqual([]);
  });
});

describe('the Codex wake bridge', () => {
  const THREAD_ID = '01a103c9-80b0-7ab1-82e3-6f4a2f70ad86';

  const queued = (calls: string) => (statSync(calls, { throwIfNoEntry: false }) ? readFileSync(calls, 'utf8') : '');

  it("logs arming for the Codex task in the plugin's log, and keeps no log of its own", async () => {
    fleet = await aWakingFleet([inbox(1)]);
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
    fleet = await aWakingFleet([inbox(0), { ...inbox(1), hold }]);
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
    fleet = await aWakingFleet([inbox(1)]);
    crew(fleet.url);
    aTurnEnded();
    const codex = aCodex();

    await start('aeolus-codex-wake.sh', { args: ['run', THREAD_ID], env: codex.env }).exited;

    expect(actions().at(-1)).toEqual({ ...scout, action: 'wakeBridge', outcome: `queued a hand-over of ${DELIVERY_ID} to Codex task ${THREAD_ID}` });
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
    fleet = await aWakingFleet([inbox(1)]);
    crew(fleet.url);
    aTurnEnded();
    const codex = aCodex();
    writeFileSync(join(data, 'bin', 'codex'), '#!/usr/bin/env bash\necho "no such thread" >&2\nexit 1\n');

    await start('aeolus-codex-wake.sh', { args: ['run', THREAD_ID], env: codex.env }).exited;

    expect(actions().at(-1)).toEqual({
      ...scout,
      action: 'wakeBridge',
      outcome: `failed: codex did not queue the hand-over to Codex task ${THREAD_ID}: no such thread`,
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
    fleet = await aWakingFleet([inbox(1)]);
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
    expect(readFileSync(calls, 'utf8')).toContain(`queue --thread ${threadId} --message Aeolus handed a message for scout to this task:`);
    expect(readFileSync(calls, 'utf8')).not.toContain(CREW_TOKEN);
  });

  it('detaches from SessionStart and still queues the task when a delivery arrives', async () => {
    fleet = await aWakingFleet([inbox(1)]);
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
    fleet = await aWakingFleet([inbox(1)]);
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
    expect(exported.stdout.toString()).toBe(`${realpathSync(folder)}\n${data}\n/plugin\n`);
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
    run('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', SHIP_ID, 'tester-k3x9', 'team-one'], stdin: CREW_TOKEN });

    const { stdout } = hook(payloadFor(folder, 'compact'));

    const context = hookOutputSchema.parse(JSON.parse(stdout)).hookSpecificOutput.additionalContext;
    expect(context).toContain('This ship is a member of the squadron team-one.');
    expect(context).toContain('Before anything else, check in at its flagship team-one, as the Aeolus Fleet crew-a-ship skill says for a squadron member.');
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
    expect(exported.stdout.toString()).toBe(realpathSync(folder));
    expect(env).toContain('export AEOLUS_FOLDER=');
    expect(hookOutputSchema.parse(JSON.parse(stdout)).hookSpecificOutput.additionalContext).toContain(`This folder crews the Aeolus ship scout (${SHIP_ID})`);
  });

  it('keys the ship by the payload cwd, its JSON escapes undone, as the scripts do', () => {
    const windowsFolder = 'C:\\Users\\thomas\\fleet "work"';
    run('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', SHIP_ID, 'scout'], stdin: CREW_TOKEN, env: { AEOLUS_FOLDER: windowsFolder } });

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

/** Runs a hook as Claude Code does, with the test's own variables over it. */
function aHook(script: string, { payload, env = {} }: { payload: Record<string, unknown>; env?: Record<string, string> }): Promise<Run> {
  return start(script, {
    stdin: JSON.stringify({ session_id: 'c5858406-be86-46cd-8591-f4fb39b1fa61', cwd: folder, ...payload }),
    env: { AEOLUS_FOLDER: '', AEOLUS_DATA: '', CLAUDE_PROJECT_DIR: folder, CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: '/plugin', ...NO_WAITS, ...env },
  }).done;
}

const aFirstToolCall = (env: Record<string, string> = {}) =>
  aHook('aeolus-handover.sh', { payload: { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/tmp/x' } }, env });
/** A tool call of a sub-agent, as a background Explore agent makes it while the session's turn has ended: Claude Code names the agent in the payload. */
const aSubAgentToolCall = () =>
  aHook('aeolus-handover.sh', {
    payload: { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/tmp/x' }, agent_id: 'a81bad3ce5f450f9a', agent_type: 'Explore' },
  });

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
    fleet = await startStubFleet([{ status: 401, body: { code: 'UNAUTHORIZED', message: 'Call with the crew token' } }, inbox(1), receiving(aDelivery()), handedOk]);
    crew(fleet.url);
    aTurnEnded();
    await start('aeolus-wait.sh').exited;
    await start('aeolus-wait.sh').exited;

    expect(claudeHook('aeolus-stop.sh', endingTheTurn).stdout).toContain('"decision":"block"');
  });

  it('re-arms the Codex wake bridge for the task by itself at the end of every turn', async () => {
    fleet = await aWakingFleet([inbox(1)]);
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
    run('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', SHIP_ID, 'tester-k3x9', 'team-one'], stdin: CREW_TOKEN });
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
    run('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', SHIP_ID, 'tester-k3x9', 'team-one'], stdin: CREW_TOKEN });

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
    expect(run('aeolus-identity.sh', { args: ['write', '--wake-by', 'trierarch', 'https://fleet.example.com', SHIP_ID, 'scout'], stdin: CREW_TOKEN, env }).status).toBe(0);
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
    run('aeolus-identity.sh', { args: ['write', '--wake-by', 'trierarch', 'https://fleet.example.com', SHIP_ID, 'tester-k3x9', 'team-one'], stdin: CREW_TOKEN });

    expect(readFileSync(identityFile(), 'utf8')).toMatch(/squadron=team-one\n[\s\S]*wakeBy=trierarch\n|wakeBy=trierarch\n[\s\S]*squadron=team-one\n/);
  });

  it('refuses to wake by anything but the trierarch', () => {
    const written = run('aeolus-identity.sh', { args: ['write', '--wake-by', 'cron', 'https://fleet.example.com', SHIP_ID, 'scout'], stdin: CREW_TOKEN });

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

    expect(claudeHook('aeolus-turn.sh', { hook_event_name: 'UserPromptSubmit', prompt: '/aeolus-fleet:wake' })).toMatchObject({ status: 0, stdout: '' });

    const { status, stdout } = turn();
    expect(status).toBe(0);
    expect(stdout.trim()).toMatch(TURN_MARKER);
    expect(stdout).toMatch(/^busy /);
  });

  it('marks the turn idle when it ends, with when', () => {
    crewedByATrierarch();
    claudeHook('aeolus-turn.sh', { hook_event_name: 'UserPromptSubmit', prompt: '/aeolus-fleet:wake' });

    claudeHook('aeolus-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false });

    expect(turn().stdout.trim()).toMatch(TURN_MARKER);
    expect(turn().stdout).toMatch(/^idle /);
  });

  it('marks the turn in a Codex session alike', () => {
    crewedByATrierarch(AS_CODEX);

    codexHook('aeolus-turn.sh', { hook_event_name: 'UserPromptSubmit', prompt: '/aeolus-fleet:wake' });
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
    claudeHook('aeolus-turn.sh', { hook_event_name: 'UserPromptSubmit', prompt: '/aeolus-fleet:wake' });

    run('aeolus-identity.sh', { args: ['delete'] });

    expect(readdirSync(data, { recursive: true }).map(String).filter((name) => name.endsWith('.turn'))).toEqual([]);
  });
});

describe("the launch marker: what a session's hooks saw of the launch the trierarch started it for (#490)", () => {
  const LAUNCH = 'lnc-2026-10-12T05:00:00.000Z';
  const TRANSCRIPT = '/home/someone/.claude/projects/-a folder/c5858406.jsonl';
  const WHEN = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z';

  function crewedByATrierarch(): void {
    expect(run('aeolus-identity.sh', { args: ['write', '--wake-by', 'trierarch', 'https://fleet.example.com', SHIP_ID, 'scout'], stdin: CREW_TOKEN }).status).toBe(0);
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
    run('aeolus-identity.sh', { args: ['write', '--wake-by', 'trierarch', 'https://fleet.example.com', SHIP_ID, 'scout'], stdin: CREW_TOKEN, env: AS_CODEX });

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
    fleet = await startStubFleet([inbox(2), receiving(aDelivery()), handedOk]);
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
    fleet = await startStubFleet([inbox(0), inbox(2), receiving(aDelivery()), handedOk]);
    crew(fleet.url);
    aTurnEnded();

    await start('aeolus-wait.sh').exited;

    expect(actions().slice(1)).toEqual([
      { ...scout, action: 'watch', outcome: 'started' },
      { ...scout, action: 'wake', outcome: `woken, 2 deliveries wait: handed ${DELIVERY_ID} over` },
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
    fleet = await startStubFleet([{ status: 500, body: {} }, { status: 503, body: {} }, inbox(0), inbox(1), receiving(aDelivery()), handedOk]);
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
    run('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', SHIP_ID, 'tester-k3x9', 'team-one'], stdin: CREW_TOKEN });
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

    expect(run('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', SHIP_ID, 'scout'], stdin: CREW_TOKEN, env: { AEOLUS_CREWS: named } }).status).toBe(0);

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
    run('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', SHIP_ID, 'tester-k3x9', 'team-one'], stdin: CREW_TOKEN });
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
    fleet = await aWakingFleet([inbox(1)]);
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
      run('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', SHIP_ID, 'tester-k3x9', 'team-one'], stdin: CREW_TOKEN });
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
      `ship: scout (${SHIP_ID})\nfleet: https://fleet.example.com\nfolder: ${realpathSync(folder)}\ncheck-in: 30m\n`,
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

describe("a ship's read-only checkouts, which its trierarch keeps (#1182)", () => {
  let sockets: string;
  const GOVERNANCE = '/home/thomas/.aeolus/trierarch/checkouts/scout/governance';
  const SKILLS = '/home/thomas/.aeolus/trierarch/checkouts/scout/skills';

  beforeEach(() => {
    // Short, under /tmp: a Unix socket path is at most 104 bytes on macOS.
    sockets = mkdtempSync('/tmp/aeolus-sock-');
  });

  afterEach(() => {
    rmSync(sockets, { recursive: true, force: true });
  });

  /** The trierarch writes the folder's identity with its socket and the checkouts given. */
  function crewedWithCheckouts(checkouts: readonly string[], { env = {}, isFolderReadOnly = false }: { env?: Record<string, string>; isFolderReadOnly?: boolean } = {}): string {
    const socket = join(sockets, 'fleet.sock');
    const args = ['write', '--wake-by', 'trierarch', '--socket', socket, ...checkouts.flatMap((checkout) => ['--checkout', checkout]), ...(isFolderReadOnly ? ['--read-only-folder'] : []), 'https://fleet.example.com', SHIP_ID, 'scout'];
    expect(run('aeolus-identity.sh', { args, stdin: CREW_TOKEN, env }).status).toBe(0);
    return socket;
  }

  /** Runs the refresh without waiting, so the stub on the socket, in this process, can answer. */
  const refresh = () => start('aeolus-checkouts.sh', { args: ['refresh'] }).done;

  function sessionStart(env: Record<string, string>) {
    const envFile = join(data, 'session.env');
    writeFileSync(envFile, '');
    const { stdout } = run('aeolus-session-start.sh', {
      stdin: JSON.stringify({ session_id: 'c5858406-be86-46cd-8591-f4fb39b1fa61', cwd: folder, hook_event_name: 'SessionStart', source: 'startup' }),
      env: { AEOLUS_FOLDER: '', AEOLUS_DATA: '', CLAUDE_ENV_FILE: envFile, ...env },
    });
    return hookOutputSchema.parse(JSON.parse(stdout)).hookSpecificOutput.additionalContext;
  }

  const STATED = `Read-only checkouts beside this folder: governance at ${GOVERNANCE}, skills at ${SKILLS}. Read them; never change, commit or push in them.`;

  it("names each checkout and where it is in a Claude Code session's start context", () => {
    crewedWithCheckouts([`governance=${GOVERNANCE}`, `skills=${SKILLS}`]);

    const context = sessionStart({ CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: '/plugin' });

    expect(context).toContain(STATED);
    expect(context).toContain('To bring them to the latest main, run "/plugin/scripts/aeolus-checkouts.sh" refresh: it answers the revision each now holds, or why it could not.');
  });

  it("names each checkout and where it is in a Codex session's start context", () => {
    crewedWithCheckouts([`governance=${GOVERNANCE}`, `skills=${SKILLS}`], { env: AS_CODEX });

    const context = sessionStart({ PLUGIN_DATA: data, PLUGIN_ROOT: SCRIPTS.replace(/\/scripts\/$/, '') });

    expect(context).toContain(STATED);
    expect(context).toContain('aeolus-checkouts.sh refresh');
  });

  it('names no checkouts for a ship that has none', () => {
    crewedWithCheckouts([]);

    const context = sessionStart({ CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: '/plugin' });

    expect(context).not.toContain('checkouts');
  });

  it('says in the start context that a read-only folder is read-only and on main, and that the refresh brings it too (aeolus-fleet#1449)', () => {
    crewedWithCheckouts([`skills=${SKILLS}`], { isFolderReadOnly: true });

    const context = sessionStart({ CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: '/plugin' });

    expect(context).toContain(`Read-only checkouts beside this folder: skills at ${SKILLS}. Read them; never change, commit or push in them.`);
    expect(context).toContain('This folder is read-only too, on main: never change, commit or push in it, and keep working files in your temporary folder.');
    expect(context).toContain('To bring them and this folder to the latest main, run "/plugin/scripts/aeolus-checkouts.sh" refresh: it answers the revision each now holds, or why it could not.');
  });

  it('says a read-only folder with no checkouts beside it is read-only, and how to refresh it (aeolus-fleet#1449)', () => {
    crewedWithCheckouts([], { isFolderReadOnly: true });

    const context = sessionStart({ CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: '/plugin' });

    expect(context).toContain('This folder is read-only, on main: never change, commit or push in it, and keep working files in your temporary folder.');
    expect(context).toContain('To bring this folder to the latest main, run "/plugin/scripts/aeolus-checkouts.sh" refresh: it answers the revision it now holds, or why it could not.');
  });

  it('refuses a read-only folder in a folder no trierarch crews (aeolus-fleet#1449)', () => {
    const written = run('aeolus-identity.sh', { args: ['write', '--read-only-folder', 'https://fleet.example.com', SHIP_ID, 'scout'], stdin: CREW_TOKEN });

    expect(written.status).toBe(2);
    expect(statSync(identityFile(), { throwIfNoEntry: false })).toBeUndefined();
  });

  it('refuses a checkout that names no repository and path', () => {
    const written = run('aeolus-identity.sh', { args: ['write', '--wake-by', 'trierarch', '--checkout', GOVERNANCE, 'https://fleet.example.com', SHIP_ID, 'scout'], stdin: CREW_TOKEN });

    expect(written.status).toBe(2);
    expect(statSync(identityFile(), { throwIfNoEntry: false })).toBeUndefined();
  });

  it('asks the trierarch over its socket to refresh the checkouts, and prints its answer: the revision each now holds, or why it could not', async () => {
    const socket = crewedWithCheckouts([`governance=${GOVERNANCE}`]);
    const answer = { checkouts: [{ repository: 'governance', revision: '3f2a9c1' }, { repository: 'skills', problem: 'git fetch failed' }] };
    fleet = await startRoutedStubFleet({ '/trierarch/checkouts/refresh': [{ status: 200, body: answer }] }, { socket });

    const refreshed = await refresh();

    expect(refreshed.status).toBe(0);
    expect(JSON.parse(refreshed.stdout)).toEqual(answer);
    expect(fleet.calls.map(({ method, path, authorization }) => ({ method, path, authorization }))).toEqual([{ method: 'POST', path: '/trierarch/checkouts/refresh', authorization: undefined }]);
  });

  it('says so and exits 1 when the trierarch refuses', async () => {
    const socket = crewedWithCheckouts([`governance=${GOVERNANCE}`]);
    fleet = await startRoutedStubFleet({ '/trierarch/checkouts/refresh': [{ status: 403, body: { code: 'FORBIDDEN', message: "This socket answers only its ship's own session" } }] }, { socket });

    const refreshed = await refresh();

    expect({ status: refreshed.status, stdout: refreshed.stdout }).toEqual({ status: 1, stdout: "aeolus: the trierarch refused the refresh: FORBIDDEN: This socket answers only its ship's own session\n" });
  });

  it('exits 6 when the trierarch does not answer', () => {
    const socket = crewedWithCheckouts([`governance=${GOVERNANCE}`]);

    const refreshed = run('aeolus-checkouts.sh', { args: ['refresh'] });

    expect({ status: refreshed.status, stdout: refreshed.stdout }).toEqual({ status: 6, stdout: `aeolus: no answer from the trierarch at ${socket}\n` });
  });

  it('exits 2 in a folder no trierarch crews: no trierarch keeps its checkouts', () => {
    expect(run('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', SHIP_ID, 'scout'], stdin: CREW_TOKEN }).status).toBe(0);

    const refreshed = run('aeolus-checkouts.sh', { args: ['refresh'] });

    expect({ status: refreshed.status, stdout: refreshed.stdout }).toEqual({ status: 2, stdout: 'aeolus: no trierarch crews this folder, so none keeps checkouts for it\n' });
  });
});

describe('the version guard: an older plugin never touches the delivery store a newer one owns (aeolus-fleet#1318)', () => {
  const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
  const PROMPT = { hook_event_name: 'UserPromptSubmit', prompt: 'go on' };
  const TOOL_CALL = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/tmp/x' } };
  const ackBodies = (stub: StubFleet) => stub.calls.filter((call) => call.path === '/api/v1/ship/ack').map((call) => call.body);

  /** A copy of this plugin that says it is another version, as a second plugin of a session is. */
  function aPluginOfVersion(version: string): string {
    const root = mkdtempSync(join(tmpdir(), 'aeolus-plugin-'));
    for (const part of ['scripts', '.claude-plugin', '.codex-plugin']) cpSync(join(PLUGIN, part), join(root, part), { recursive: true });
    for (const manifest of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
      const file = join(root, manifest);
      writeFileSync(file, readFileSync(file, 'utf8').replace(/"version": "[^"]*"/, `"version": "${version}"`));
    }
    return root;
  }

  /** Runs a hook of the plugin in a root, as Claude Code does. */
  const hookOf = (root: string) => (script: string, payload: Record<string, unknown>): Promise<Run> => {
    const child = spawn('bash', [join(root, 'scripts', script)], {
      env: scriptEnvironment({
        HOME: home, AEOLUS_FOLDER: '', AEOLUS_DATA: '', CLAUDE_PROJECT_DIR: folder, CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: root,
        AEOLUS_RETRY_SECONDS: '0', AEOLUS_POLL_SECONDS: '0.05', ...NO_WAITS,
      }),
    });
    child.stdin.end(JSON.stringify({ session_id: 'c5858406-be86-46cd-8591-f4fb39b1fa61', cwd: folder, ...payload }));
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    return new Promise((resolve) => {
      child.on('close', (status) => {
        resolve({ status, stdout, stderr });
      });
    });
  };

  const plugins: string[] = [];
  const aPlugin = (version: string) => {
    const root = aPluginOfVersion(version);
    plugins.push(root);
    return root;
  };
  afterEach(() => {
    for (const root of plugins.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** The plugin hands one message over: the watcher receives it while the session is idle. */
  async function aHandedMessage(routes: Record<string, readonly StubAnswer[]> = {}): Promise<StubFleet> {
    fleet = await startRoutedStubFleet({
      '/api/v1/ship/inbox': [inbox(1)],
      '/api/v1/ship/pushReceive': [receiving(aDelivery())],
      '/api/v1/ship/handed': [handedOk],
      '/api/v1/ship/ack': [acknowledged],
      ...routes,
    });
    crew(fleet.url);
    aTurnEnded();
    await start('aeolus-wait.sh').exited;
    return fleet;
  }

  const store = () => run('aeolus-identity.sh', { args: ['store'] }).stdout.trim();
  /** Every file under the store folders, by path and bytes. */
  const storeBytes = () => {
    const crews = join(home, '.aeolus', 'crews');
    const files: Record<string, string> = {};
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (path.includes('.store')) files[path] = readFileSync(path, 'utf8');
      }
    };
    walk(crews);
    return files;
  };
  const newerPluginOwns = () => actions().filter((record) => 'outcome' in record && record.outcome.includes('a newer plugin owns'));

  it('changes nothing in the store and acknowledges nothing, when its version is lower than the one that last wrote it', async () => {
    const stub = await aHandedMessage();
    const before = storeBytes();

    const prompted = await hookOf(aPlugin('0.24.0'))('aeolus-turn.sh', PROMPT);
    const toolCall = await hookOf(aPlugin('0.24.0'))('aeolus-handover.sh', TOOL_CALL);

    expect(Object.keys(before).length).toBeGreaterThan(0);
    expect({ stdout: [prompted.stdout, toolCall.stdout], acks: ackBodies(stub), store: storeBytes() }).toEqual({ stdout: ['', ''], acks: [], store: before });
  });

  it('logs once that a newer plugin owns the store', async () => {
    await aHandedMessage();
    const older = aPlugin('0.24.0');

    await hookOf(older)('aeolus-turn.sh', PROMPT);
    await hookOf(older)('aeolus-handover.sh', TOOL_CALL);
    await hookOf(older)('aeolus-stop.sh', { hook_event_name: 'Stop', stop_hook_active: true });

    expect(newerPluginOwns()).toHaveLength(1);
  });

  it('lets the newer plugin acknowledge the message and put it into the turn, when the older plugin hooks the prompt first', async () => {
    const stub = await aHandedMessage();

    await hookOf(aPlugin('0.24.0'))('aeolus-turn.sh', PROMPT);
    const prompted = await hookOf(PLUGIN)('aeolus-turn.sh', PROMPT);

    expect({ acks: ackBodies(stub).length, context: prompted.stdout.includes('Review \\"PR 12\\"'), confirmed: store().includes(`${DELIVERY_ID} confirmed`) }).toEqual({
      acks: 1,
      context: true,
      confirmed: true,
    });
  });

  it('lets the newer plugin acknowledge the message and put it into the turn, when it hooks the prompt first', async () => {
    const stub = await aHandedMessage();

    const prompted = await hookOf(PLUGIN)('aeolus-turn.sh', PROMPT);
    await hookOf(aPlugin('0.24.0'))('aeolus-turn.sh', PROMPT);

    expect({ acks: ackBodies(stub).length, context: prompted.stdout.includes('Review \\"PR 12\\"'), confirmed: store().includes(`${DELIVERY_ID} confirmed`) }).toEqual({
      acks: 1,
      context: true,
      confirmed: true,
    });
  });

  it('works on the store as today, when its version is newer than the one that last wrote it, and records its version', async () => {
    const stub = await aHandedMessage();
    const newer = aPlugin('99.0.0');

    const prompted = await hookOf(newer)('aeolus-turn.sh', PROMPT);
    const older = await hookOf(PLUGIN)('aeolus-handover.sh', TOOL_CALL);

    expect({ acks: ackBodies(stub).length, context: prompted.stdout.includes('Review'), olderStdout: older.stdout, owned: newerPluginOwns().length }).toEqual({
      acks: 1,
      context: true,
      olderStdout: '',
      owned: 1,
    });
  });

  it('works on the store as today, when its version is the one that last wrote it', async () => {
    const stub = await aHandedMessage();

    const prompted = await hookOf(PLUGIN)('aeolus-turn.sh', PROMPT);

    expect({ acks: ackBodies(stub).length, context: prompted.stdout.includes('Review'), owned: newerPluginOwns().length }).toEqual({ acks: 1, context: true, owned: 0 });
  });

  describe('a plugin upgraded under a running session the trierarch crews (aeolus-fleet#1445)', () => {
    const STOP = { hook_event_name: 'Stop', stop_hook_active: true };

    /** The trierarch hands one message over with the plugin in a root, as it runs the newest plugin in the cache. */
    const trierarchHands = (root: string): Promise<Run> => {
      const child = spawn('bash', [join(root, 'scripts', 'aeolus-push.sh'), 'hand'], {
        env: scriptEnvironment({ HOME: home, AEOLUS_FOLDER: folder, AEOLUS_DATA: data, AEOLUS_CREWS: join(home, '.aeolus', 'crews', 'claude-code'), AEOLUS_RETRY_SECONDS: '0', ...NO_WAITS }),
      });
      child.stdin.end('');
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      return new Promise((resolve) => {
        child.on('close', (status) => {
          resolve({ status, stdout, stderr: '' });
        });
      });
    };

    it('puts a message the trierarch hands over after the upgrade into the turn of the session still on the older plugin', async () => {
      fleet = await startRoutedStubFleet({
        '/api/v1/ship/pushReceive': [receiving(aDelivery()), receiving(aDelivery({ deliveryId: 'dlv_01m4rb7cq8m6d0x3ycsn1f4c2t', messageId: 'msg_01m4rb7cq8m6d0x3ycsn1f4c2s', payload: 'Merge "PR 12"' }))],
        '/api/v1/ship/handed': [handedOk],
        '/api/v1/ship/ack': [acknowledged],
        '/api/v1/ship/handled': [taken],
        '/api/v1/ship/turn': [taken],
      });
      expect(run('aeolus-identity.sh', { args: ['write', '--wake-by', 'trierarch', fleet.url, SHIP_ID, 'scout'], stdin: CREW_TOKEN }).status).toBe(0);
      const session = hookOf(aPlugin('0.34.0'));
      await session('aeolus-stop.sh', STOP);
      expect((await trierarchHands(aPlugin('0.34.0'))).status).toBe(0);
      await session('aeolus-turn.sh', PROMPT);
      await session('aeolus-stop.sh', STOP);

      expect((await trierarchHands(aPlugin('0.35.0'))).status).toBe(0);
      const prompted = await session('aeolus-turn.sh', PROMPT);

      expect({ acks: ackBodies(fleet).length, context: prompted.stdout.includes('Merge \\"PR 12\\"') }).toEqual({ acks: 2, context: true });
    });
  });
});
