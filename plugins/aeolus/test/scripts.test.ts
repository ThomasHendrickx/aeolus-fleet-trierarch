import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { startStubFleet, type StubFleet } from './stub-fleet.js';

// The aeolus plugin's bash scripts, as a session runs them: in its folder,
// with the plugin's data folder, against a stub of the fleet's REST door.

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));
const CREW_TOKEN = 'aeolus_ct_v1_crew';
const SHIP_ID = 'shp_01m3tbfspe96yf1rnr4ank9h1a';

let data: string;
let folder: string;
let fleet: StubFleet | undefined;

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'aeolus-data-'));
  folder = mkdtempSync(join(tmpdir(), 'aeolus folder "one"-'));
});

afterEach(async () => {
  if (statSync(identityFile(), { throwIfNoEntry: false })) {
    run('aeolus-identity.sh', { args: ['delete'] });
  }
  await fleet?.close();
  fleet = undefined;
  rmSync(data, { recursive: true, force: true });
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
    env: { ...process.env, AEOLUS_FOLDER: folder, AEOLUS_DATA: data, AEOLUS_RETRY_SECONDS: '0', ...options.env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Runs a script without waiting for it, for one that keeps running. */
function start(script: string, options: { args?: string[]; env?: Record<string, string>; stdin?: string } = {}) {
  const child = spawn('bash', [join(SCRIPTS, script), ...(options.args ?? [])], {
    env: { ...process.env, AEOLUS_FOLDER: folder, AEOLUS_DATA: data, AEOLUS_RETRY_SECONDS: '0', ...options.env },
  });
  child.stdin.end(options.stdin ?? '');
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  const exited = new Promise<{ status: number | null; stdout: string }>((resolve) => {
    child.on('exit', (status) => {
      resolve({ status, stdout });
    });
  });
  return { child, exited };
}

function crew(fleetUrl = 'https://fleet.example.com'): void {
  expect(run('aeolus-identity.sh', { args: ['write', fleetUrl, SHIP_ID, 'scout', CREW_TOKEN] }).status).toBe(0);
}

function identityFile(): string {
  return run('aeolus-identity.sh', { args: ['path'] }).stdout.trim();
}

function pidFile(): string {
  return identityFile().replace(/\.identity$/, '.watch.pid');
}

function wakePidFile(): string {
  return identityFile().replace(/\.identity$/, '.wake.pid');
}

function wakeThreadFile(): string {
  return identityFile().replace(/\.identity$/, '.wake.thread');
}

const inbox = (waiting: number) => ({ status: 200, body: { waiting } });

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
      expect(readdirSync(join(data, 'ships'))).toHaveLength(2);
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
      expect(readdirSync(join(data, 'ships'))).toEqual([]);
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

describe('aeolus-wait', () => {
  it("asks the inbox check with the crew token, keeps asking while none wait, and exits 0 once some do", async () => {
    fleet = await startStubFleet([inbox(0), inbox(0), inbox(2)]);
    crew(fleet.url);

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
      stdout: 'aeolus: LEASE_ENDED: the operator released scout; this session no longer crews it\n',
    });
  });

  it('exits 5 when the fleet refuses the crew token', async () => {
    fleet = await startStubFleet([{ status: 401, body: { code: 'UNAUTHORIZED', message: 'Call with the crew token' } }]);
    crew(fleet.url);

    await expect(start('aeolus-wait.sh').exited).resolves.toMatchObject({ status: 5 });
  });

  it('retries a failing fleet quietly, then exits 0 once deliveries wait', async () => {
    fleet = await startStubFleet([{ status: 500, body: {} }, { status: 503, body: {} }, inbox(1)]);
    crew(fleet.url);

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

describe('the Codex wake bridge', () => {
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

describe('aeolus-mcp-hint', () => {
  it('tells a session on a device or a server to add the fleet MCP server with claude mcp add', () => {
    expect(run('aeolus-mcp-hint.sh', { args: ['https://fleet.example.com/'], env: { CLAUDE_CODE_REMOTE: '' } }).stdout).toBe(
      'Add the fleet MCP server once, then start a new session in this folder and paste the crew line again:\n' +
        'claude mcp add --transport http --scope user aeolus https://fleet.example.com/mcp\n',
    );
  });

  it('tells a claude.ai cloud session to add the fleet as a claude.ai connector instead', () => {
    const { stdout } = run('aeolus-mcp-hint.sh', { args: ['https://fleet.example.com'], env: { CLAUDE_CODE_REMOTE: 'true' } });

    expect(stdout).toBe(
      'This is a claude.ai cloud session: its MCP servers come from claude.ai connectors, not from claude mcp add.\n' +
        'Add a custom connector in claude.ai (Settings, Connectors) with the URL https://fleet.example.com/mcp,\n' +
        'then start a new cloud session and paste the crew line again.\n',
    );
    expect(stdout).not.toContain('claude mcp add --transport');
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

  it('says nothing to a folder that crews no ship', () => {
    expect(hook(payloadFor(folder))).toMatchObject({ status: 0, stdout: '' });
  });

  it('tells a fresh context after /clear which ship it crews, where its crew token is, and to start the watcher', () => {
    crew();

    const { status, stdout } = hook(payloadFor(folder, 'clear'));

    expect(status).toBe(0);
    const context = hookOutputSchema.parse(JSON.parse(stdout)).hookSpecificOutput.additionalContext;
    expect(context).toContain(`This folder crews the Aeolus ship scout (${SHIP_ID}) in the fleet at https://fleet.example.com.`);
    expect(context).toContain(`Its crew token is the crewToken line of ${identityFile()}`);
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
    await start('aeolus-wait.sh').exited;
    await start('aeolus-wait.sh').exited;

    expect(claudeHook('aeolus-stop.sh', endingTheTurn).stdout).toContain('"decision":"block"');
  });

  it('re-arms the Codex wake bridge for the task by itself at the end of every turn', async () => {
    fleet = await startStubFleet([inbox(1)]);
    crew(fleet.url);
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

  function crewedByATrierarch(): void {
    expect(run('aeolus-identity.sh', { args: ['write', '--wake-by', 'trierarch', 'https://fleet.example.com', SHIP_ID, 'scout', CREW_TOKEN] }).status).toBe(0);
  }

  /** The turn marker as the trierarch reads it, through the plugin's own script. */
  function turn(): Run {
    return run('aeolus-identity.sh', { args: ['turn'] });
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
    crewedByATrierarch();

    const context = sessionStart({ PLUGIN_DATA: data, PLUGIN_ROOT: SCRIPTS.replace(/\/scripts\/$/, '') });

    expect(context).toContain('The trierarch wakes this session when work arrives: start no watcher.');
    expect(context).not.toContain('wake-up');
    expect(statSync(wakePidFile(), { throwIfNoEntry: false })).toBeUndefined();
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
    crewedByATrierarch();

    expect(codexHook('aeolus-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false })).toMatchObject({ status: 0, stdout: '' });
    expect(statSync(wakePidFile(), { throwIfNoEntry: false })).toBeUndefined();
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
    crewedByATrierarch();

    codexHook('aeolus-turn.sh', { hook_event_name: 'UserPromptSubmit', prompt: '/aeolus:wake' });
    expect(turn().stdout).toMatch(/^busy /);
    codexHook('aeolus-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false });
    expect(turn().stdout).toMatch(/^idle /);
  });

  it('says no turn has been marked before the first prompt', () => {
    crewedByATrierarch();

    expect(turn()).toMatchObject({ status: 1, stdout: 'aeolus: no turn marked yet\n' });
  });

  it('marks no turn in a folder without the line, which behaves as today', () => {
    crew();

    claudeHook('aeolus-turn.sh', { hook_event_name: 'UserPromptSubmit', prompt: 'hello' });

    expect(turn().status).toBe(1);
    expect(readdirSync(data, { recursive: true }).map(String).filter((name) => name.endsWith('.turn'))).toEqual([]);
  });

  it('forgets the turn marker with the ship', () => {
    crewedByATrierarch();
    claudeHook('aeolus-turn.sh', { hook_event_name: 'UserPromptSubmit', prompt: '/aeolus:wake' });

    run('aeolus-identity.sh', { args: ['delete'] });

    expect(readdirSync(data, { recursive: true }).map(String).filter((name) => name.endsWith('.turn'))).toEqual([]);
  });
});
