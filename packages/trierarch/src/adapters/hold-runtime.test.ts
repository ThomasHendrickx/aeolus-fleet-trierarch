import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FAKE_CLAUDE_CODE, TRIERARCH_PROGRAM } from '../../test/support/hold-program.js';
import { newId } from '../../test/support/in-memory.js';
import { sessionRuntimeContract } from '../../test/support/session-runtime-contract.js';
import type { ObservedSession, SessionRuntime } from '../core/ports.js';
import { createCallerCheck } from './caller-check.js';
import { createHoldRuntime, sessionsLaunch } from './hold-runtime.js';
import { runningVersion } from './version.js';

// Against real holds, each the trierarch program from source started as the
// trierarch starts it, running the stand-in for Claude Code in print mode
// with streamed JSON, or a shell command. The folders sit under /tmp: a Unix
// socket path is at most 104 bytes on macOS.

/** The version a hold states: the trierarch's own, which runs it. */
const VERSION = runningVersion();
/** A user line as Claude Code takes it on stdin. */
const userLine = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

let sessions: string;
let folder: string;
let runtimes: SessionRuntime[];

beforeEach(() => {
  sessions = realpathSync(mkdtempSync('/tmp/aeolus-holds-'));
  folder = realpathSync(mkdtempSync('/tmp/aeolus-folder-'));
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
function aRuntime(at: { version?: string; legacy?: Pick<SessionRuntime, 'list' | 'stop'>; bootedAt?: () => Date } = {}) {
  const runtime = createHoldRuntime({ sessions, program: TRIERARCH_PROGRAM, version: at.version ?? VERSION, platform: process.platform, ...(at.legacy !== undefined && { legacy: at.legacy }), ...(at.bootedAt !== undefined && { bootedAt: at.bootedAt }) });
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

/** Each start of the stand-in, as it wrote it down. */
const starts = () => written('fake-starts.jsonl').map((start) => startSchema.parse(start));

async function aClaudeCodeSession(runtime: SessionRuntime, flags: readonly string[] = []): Promise<ShipId> {
  const shipId = newId('ship');
  await runtime.start({ shipId, folder, command: [...FAKE_CLAUDE_CODE, ...flags], harness: 'claude-code' });
  return shipId;
}

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

  it("starts the harness with none of the trierarch's environment: only HOME, PATH and what the start gives (H10)", async () => {
    process.env.AEOLUS_TEST_TRIERARCH_SECRET = 'held by the trierarch';
    try {
      const runtime = aRuntime();
      const shipId = newId('ship');

      await runtime.start({ shipId, folder, command: [...FAKE_CLAUDE_CODE], env: { AEOLUS_LAUNCH: 'launch-1' }, harness: 'claude-code' });

      await expect.poll(() => written('fake-starts.jsonl')).toHaveLength(1);
      const [start] = starts();
      expect(Object.keys(start?.env ?? {}).sort()).toEqual(['AEOLUS_LAUNCH', 'HOME', 'PATH']);
      expect(start?.env.AEOLUS_LAUNCH).toBe('launch-1');
    } finally {
      delete process.env.AEOLUS_TEST_TRIERARCH_SECRET;
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
  });

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

    await runtime.send({ shipId, line: userLine('/aeolus:wake') });

    await expect.poll(async () => runtime.list()).toEqual([{ shipId, status: 'exited' }]);
    await expect(eventsOfType({ runtime: runtime, shipId: shipId }, 'result')).resolves.toEqual([expect.objectContaining({ is_error: true, result: 'Not logged in · Please run /login' })]);
  });

  it('sees the session exited when its hold dies, and the harness ends with it', async () => {
    const runtime = aRuntime();
    const shipId = await aClaudeCodeSession(runtime);
    const hold = await runtime.sessionRootOf(shipId);

    process.kill(hold ?? 0, 'SIGKILL');

    await expect.poll(async () => runtime.list()).toEqual([{ shipId, status: 'exited' }]);
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

  it('lists a session an older trierarch started in tmux as of another version, and stops it before the ship starts under a hold', async () => {
    const shipId = newId('ship');
    const tmux = new Map<ShipId, ObservedSession['status']>([[shipId, 'running']]);
    const legacy = {
      list: () => Promise.resolve([...tmux].map(([id, status]) => ({ shipId: id, status }))),
      stop: (id: ShipId) => {
        tmux.delete(id);
        return Promise.resolve();
      },
    };
    const runtime = aRuntime({ legacy });

    await expect(runtime.list()).resolves.toEqual([{ shipId, status: 'running', isOtherVersion: true }]);

    await runtime.start({ shipId, folder, command: [...FAKE_CLAUDE_CODE], harness: 'claude-code' });

    expect(tmux.size).toBe(0);
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

  it('stops a session: its hold and harness end, and it is listed no more', async () => {
    const runtime = aRuntime();
    const shipId = await aClaudeCodeSession(runtime);
    const hold = await runtime.sessionRootOf(shipId);

    await runtime.stop(shipId);

    await expect(runtime.list()).resolves.toEqual([]);
    expect(() => process.kill(hold ?? 0, 0)).toThrow();
  });
});

describe('where a hold starts (#537)', () => {
  it("starts through a systemd scope of its own under a systemd unit, so the service's restart ends no session", () => {
    expect(sessionsLaunch({ platform: 'linux', env: { INVOCATION_ID: 'c0ffee' } })).toEqual(['systemd-run', '--user', '--scope', '--quiet', '--collect', '--']);
  });

  it('starts itself on Linux outside a systemd unit', () => {
    expect(sessionsLaunch({ platform: 'linux', env: {} })).toEqual([]);
  });

  it('starts itself on macOS, where launchd leaves the sessions running', () => {
    expect(sessionsLaunch({ platform: 'darwin', env: { INVOCATION_ID: 'c0ffee' } })).toEqual([]);
  });
});
