import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';

import { codexTurnCommand } from './codex.js';
import type { HoldAnswer, HoldFiles, HoldRequest } from './hold-protocol.js';
import { holdRequestSchema, parsedLine, REFUSED } from './hold-protocol.js';

/**
 * The hold (headless H8 to H12): a small process per session, started outside
 * the trierarch's service so it outlives it, the only holder of its harness's
 * stdin and stdout. It starts the harness as its child, appends every line the
 * harness writes to the session's events, keeps the harness's session id, and
 * answers the trierarch alone on its socket: send a line, interrupt the turn,
 * say its state. When the harness ends, the hold ends; when the hold is
 * stopped, the harness ends with it. A hold that dies without the chance to
 * stop it, as SIGKILL leaves it, still ends its harness: a guard, a process of
 * its own, holds a pipe from the hold and ends each harness's group once that
 * pipe closes, which the hold's death does.
 *
 * Claude Code's turn is stopped with the interrupt control request on its
 * stdin, which keeps the process (H12, Thomas, 25 Oct: "Headless option 2").
 * When Claude Code refuses it, SIGINT stops the turn and the process, and the
 * hold starts it again resuming its session, so the trierarch sees no exit.
 *
 * Codex runs one `codex exec` per turn (H11): the start command is the first
 * turn, and each line sent is the prompt of a `codex exec resume` of the
 * thread the first named, started once the last turn's process has ended.
 * Between turns no Codex process runs and the hold stays; its turn is stopped
 * with SIGINT, which ends the process (H12).
 */

/** The longest the hold waits for an interrupted turn to end before the forced line goes in anyway (timings-and-limits.md). */
export const INTERRUPT_WAIT_MS = 10_000;

/** The flag that resumes a Claude Code session by its id, and the one that continues the folder's last, which a resume replaces. */
const RESUME = '--resume';
const CONTINUE = '--continue';

/** How long the guard gives a harness's group to end after SIGTERM before SIGKILL. */
const GUARD_GRACE_MS = 2_000;

/**
 * The guard, run by Node: each stdin line is the group of a harness the hold
 * started; when stdin closes, every such group is ended. It is plain
 * JavaScript so it needs nothing the hold was started with.
 */
const GUARD = `
const groups = new Set();
const end = (signal) => {
  for (const group of groups) {
    try { process.kill(-group, signal); } catch {}
  }
};
const lines = require('node:readline').createInterface({ input: process.stdin });
lines.on('line', (line) => { groups.add(Number(line)); });
lines.on('close', () => {
  end('SIGTERM');
  setTimeout(() => { end('SIGKILL'); }, ${String(GUARD_GRACE_MS)});
});
`;

export interface HoldOptions {
  readonly files: HoldFiles;
  readonly folder: string;
  /** The harness the command runs: how its turn is stopped. */
  readonly harness: string;
  readonly command: readonly string[];
  /** The harness's whole environment: nothing else of the hold's reaches it (H10). */
  readonly environment: Readonly<Record<string, string>>;
  readonly version: string;
  /** Whether the caller at the other end of a connection to the socket is the trierarch (H9). */
  readonly mayCall: (connection: Socket) => Promise<boolean>;
}

/** A waiter for the end of the running turn, or for an answer to a control request. */
type Waiter = (event: { type: 'result' } | { type: 'control'; requestId: string; isRefused: boolean } | { type: 'exit' }) => void;

/** Runs the hold until its harness ends; answers the harness's exit code. */
export async function runHold(options: HoldOptions): Promise<number> {
  const { files, folder, harness, environment, version } = options;
  await mkdir(files.folder, { recursive: true, mode: 0o700 });
  await rm(files.socket, { force: true });
  await writeFile(files.pid, String(process.pid));
  const events = createWriteStream(files.events, { flags: 'a', mode: 0o600 });
  let sessionId: string | undefined;
  let isBusy = false;
  let isRestarting = false;
  let isStopping = false;
  const isCodex = harness === 'codex';
  let controls = 0;
  const waiters = new Set<Waiter>();
  const tell = (event: Parameters<Waiter>[0]): void => {
    for (const waiter of [...waiters]) {
      waiter(event);
    }
  };

  let resolveEnd: (code: number) => void = () => undefined;
  const ended = new Promise<number>((resolve) => {
    resolveEnd = resolve;
  });

  // A line is acted on once it is written, so whoever a result or a control response answers finds it in the events.
  const onLine = (line: string): void => {
    events.write(`${line}\n`, () => {
      onWritten(line);
    });
  };

  const onWritten = (line: string): void => {
    const event = parsedLine(line);
    if (typeof event !== 'object' || event === null) {
      return;
    }
    const type: unknown = Reflect.get(event, 'type');
    const id: unknown = Reflect.get(event, isCodex ? 'thread_id' : 'session_id');
    if (typeof id === 'string' && id !== sessionId) {
      sessionId = id;
      void writeFile(files.sessionId, id);
    }
    if (type === 'result') {
      isBusy = false;
      tell({ type: 'result' });
    }
    const response: unknown = type === 'control_response' ? Reflect.get(event, 'response') : undefined;
    if (typeof response === 'object' && response !== null) {
      const requestId: unknown = Reflect.get(response, 'request_id');
      tell({ type: 'control', requestId: typeof requestId === 'string' ? requestId : '', isRefused: Reflect.get(response, 'subtype') === 'error' });
    }
  };

  // A session of its own, so a signal to the hold's group does not end the guard before it ends the harness.
  const guard = spawn(process.execPath, ['-e', GUARD], { env: {}, stdio: ['pipe', 'ignore', 'ignore'], detached: true });
  guard.stdin.on('error', () => undefined);
  guard.unref();

  /** Kills the harness's process group: the harness and every process it started. */
  const killGroup = (running: ChildProcessByStdio<Writable, Readable, null>): void => {
    try {
      process.kill(-(running.pid ?? 0), 'SIGKILL');
    } catch {
      // Its group is gone already.
    }
  };

  const startHarness = (command: readonly string[]): ChildProcessByStdio<Writable, Readable, null> => {
    const [program = '', ...args] = command;
    // A process group of its own: a stop ends the harness and every process it started.
    const started = spawn(program, args, { cwd: folder, env: { ...environment }, stdio: ['pipe', 'pipe', 'ignore'], detached: true });
    if (started.pid !== undefined) {
      guard.stdin.write(`${String(started.pid)}\n`);
    }
    started.stdin.on('error', () => undefined);
    // codex exec reads a stdin that is no terminal to its end before its turn: it gets none.
    if (isCodex) {
      started.stdin.end();
    }
    createInterface({ input: started.stdout }).on('line', onLine);
    started.on('error', () => {
      resolveEnd(1);
    });
    started.on('exit', (code) => {
      if (isCodex && child === started) {
        isBusy = false;
        child = undefined;
      }
      tell({ type: 'exit' });
      if (isStopping || (!isRestarting && !isCodex)) {
        resolveEnd(code ?? 1);
      }
    });
    return started;
  };
  let child: ChildProcessByStdio<Writable, Readable, null> | undefined = startHarness(options.command);
  if (isCodex) {
    isBusy = true;
  }

  /** Waits until the waiter is told what it waits for, or the time is up. */
  const waitFor = (isIt: (event: Parameters<Waiter>[0]) => boolean, ms: number): Promise<Parameters<Waiter>[0] | undefined> =>
    new Promise((resolve) => {
      const waiter: Waiter = (event) => {
        if (isIt(event)) {
          finish(event);
        }
      };
      const timer = setTimeout(() => {
        finish(undefined);
      }, ms);
      const finish = (event: Parameters<Waiter>[0] | undefined): void => {
        clearTimeout(timer);
        waiters.delete(waiter);
        resolve(event);
      };
      waiters.add(waiter);
    });

  /** Claude Code started again, resuming its session, after SIGINT ended it (H12). */
  const resumed = (): readonly string[] => {
    const [program = '', ...flags] = options.command.filter((word) => word !== CONTINUE);
    return sessionId === undefined ? [program, ...flags, CONTINUE] : [program, ...flags, RESUME, sessionId];
  };

  /** Ends Codex's running turn: SIGINT, then its process group killed when it has not ended within the wait (H12). */
  const endCodexTurn = async (signal: 'SIGINT' | 'SIGKILL'): Promise<void> => {
    const running = child;
    if (running === undefined) {
      return;
    }
    const exited = waitFor((event) => event.type === 'exit', INTERRUPT_WAIT_MS);
    if (signal === 'SIGINT') {
      running.kill('SIGINT');
    } else {
      killGroup(running);
    }
    if ((await exited) === undefined && child === running) {
      killGroup(running);
      await waitFor((event) => event.type === 'exit', INTERRUPT_WAIT_MS);
    }
  };

  /** Codex's next turn, once the last turn's process has ended: a codex exec resume of the session's thread (H11). */
  const sendCodex = async (line: string): Promise<HoldAnswer> => {
    if (sessionId === undefined) {
      return { isOk: false, error: 'Codex named no thread to resume yet' };
    }
    if (child !== undefined) {
      const running = child;
      if ((await waitFor((event) => event.type === 'exit', INTERRUPT_WAIT_MS)) === undefined && child === running) {
        await endCodexTurn('SIGKILL');
      }
    }
    isBusy = true;
    child = startHarness(codexTurnCommand({ start: options.command, threadId: sessionId, line }));
    return { isOk: true };
  };

  const interrupt = async (): Promise<void> => {
    if (!isBusy) {
      return;
    }
    if (isCodex) {
      await endCodexTurn('SIGINT');
      return;
    }
    const current = child;
    if (current === undefined) {
      return;
    }
    const until = Date.now() + INTERRUPT_WAIT_MS;
    if (harness === 'claude-code') {
      controls += 1;
      const requestId = `aeolus-interrupt-${String(controls)}`;
      const turnEnd = waitFor((event) => event.type === 'result' || event.type === 'exit', INTERRUPT_WAIT_MS);
      const answer = waitFor((event) => event.type === 'control' && event.requestId === requestId, INTERRUPT_WAIT_MS);
      current.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } })}\n`);
      const answered = await Promise.race([answer, turnEnd]);
      if (answered?.type !== 'control' || !answered.isRefused) {
        await turnEnd;
        return;
      }
    }
    // SIGINT ends the turn, and Claude Code's process with it: started again resuming its session, no exit for the trierarch to see.
    isRestarting = harness === 'claude-code';
    const exited = waitFor((event) => event.type === 'exit', Math.max(0, until - Date.now()));
    current.kill('SIGINT');
    await exited;
    if (isRestarting) {
      isBusy = false;
      child = startHarness(resumed());
      isRestarting = false;
    }
  };

  const answer = async (request: HoldRequest): Promise<HoldAnswer> => {
    switch (request.call) {
      case 'send':
        if (isCodex) {
          return sendCodex(request.line);
        }
        isBusy = true;
        child?.stdin.write(`${request.line}\n`);
        return { isOk: true };
      case 'interrupt':
        await interrupt();
        return { isOk: true };
      case 'state':
        return { isOk: true, state: { status: 'running', version, ...(sessionId !== undefined && { sessionId }) } };
    }
  };

  const server = createServer((connection) => {
    connection.on('error', () => undefined);
    void (async () => {
      if (!(await options.mayCall(connection))) {
        connection.end(`${JSON.stringify({ isOk: false, error: REFUSED })}\n`);
        return;
      }
      const lines = createInterface({ input: connection });
      for await (const line of lines) {
        const request = holdRequestSchema.safeParse(parsedLine(line));
        const answered: HoldAnswer = request.success ? await answer(request.data) : { isOk: false, error: 'not a hold call' };
        connection.end(`${JSON.stringify(answered)}\n`);
        return;
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(files.socket, resolve));

  const stop = (): void => {
    isStopping = true;
    if (child === undefined) {
      resolveEnd(0);
      return;
    }
    try {
      process.kill(-(child.pid ?? 0), 'SIGTERM');
    } catch {
      // Its group is gone already.
    }
  };
  process.once('SIGTERM', stop);
  process.once('SIGHUP', stop);

  const code = await ended;
  server.close();
  await rm(files.socket, { force: true });
  await new Promise((resolve) => events.end(resolve));
  return code;
}
