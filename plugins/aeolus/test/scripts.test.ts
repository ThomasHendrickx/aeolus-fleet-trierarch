import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
function start(script: string, env: Record<string, string> = {}) {
  const child = spawn('bash', [join(SCRIPTS, script)], {
    env: { ...process.env, AEOLUS_FOLDER: folder, AEOLUS_DATA: data, AEOLUS_RETRY_SECONDS: '0', ...env },
  });
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

const inbox = (waiting: number) => ({ status: 200, body: { waiting } });

describe('aeolus-identity', () => {
  it("writes the folder's ship and shows it, naming the file that holds the crew token but never the token", () => {
    crew();

    const shown = run('aeolus-identity.sh', { args: ['show'] });

    expect(shown.status).toBe(0);
    expect(shown.stdout).toContain(`ship: scout (${SHIP_ID})`);
    expect(shown.stdout).toContain('fleet: https://fleet.example.com');
    expect(shown.stdout).toContain(`folder: ${folder}`);
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

  it('shows nothing, and fails, for a folder that crews no ship', () => {
    expect(run('aeolus-identity.sh', { args: ['show'] })).toMatchObject({ status: 1, stdout: 'aeolus: this folder crews no ship\n' });
  });

  it('forgets the ship and stops its watcher on delete', async () => {
    crew();
    const sleeper = spawn('sleep', ['30']);
    writeFileSync(pidFile(), `${String(sleeper.pid)}\n`);
    const stopped = new Promise((resolve) => sleeper.on('exit', resolve));

    expect(run('aeolus-identity.sh', { args: ['delete'] }).status).toBe(0);

    await stopped;
    expect(readdirSync(join(data, 'ships'))).toEqual([]);
  });
});

describe('aeolus-watch-status', () => {
  it('says not watching without a watcher', () => {
    expect(run('aeolus-watch-status.sh')).toMatchObject({ status: 1, stdout: 'aeolus: not watching\n' });
  });

  it('says watching while a live process holds the lock', () => {
    crew();
    writeFileSync(pidFile(), `${String(process.pid)}\n`);

    expect(run('aeolus-watch-status.sh')).toMatchObject({ status: 0, stdout: 'aeolus: watching\n' });
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

    const { exited } = start('aeolus-wait.sh', { AEOLUS_WAIT_SECONDS: '0' });
    await expect.poll(() => run('aeolus-watch-status.sh').status).toBe(0);
    answer();
    await exited;

    expect(run('aeolus-watch-status.sh').status).toBe(1);
  });

  it('exits 4 and starts no second watcher while one runs for the ship', () => {
    crew();
    writeFileSync(pidFile(), `${String(process.pid)}\n`);

    expect(run('aeolus-wait.sh')).toMatchObject({
      status: 4,
      stdout: 'aeolus: already watching: a watcher runs for this ship; do not start another\n',
    });
    expect(readFileSync(pidFile(), 'utf8')).toBe(`${String(process.pid)}\n`);
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

    const { status, stdout } = await start('aeolus-wait.sh', { AEOLUS_WAIT_SECONDS: '0', AEOLUS_MAX_SECONDS: '1' }).exited;

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
  function hook(payload: Record<string, unknown>) {
    const envFile = join(data, 'session.env');
    writeFileSync(envFile, '');
    const result = run('aeolus-session-start.sh', {
      stdin: JSON.stringify(payload),
      env: { AEOLUS_FOLDER: '', AEOLUS_DATA: '', CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: '/plugin', CLAUDE_ENV_FILE: envFile },
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

  it('keys the ship by the payload cwd, its JSON escapes undone, as the scripts do', () => {
    const windowsFolder = 'C:\\Users\\thomas\\fleet "work"';
    run('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', SHIP_ID, 'scout', CREW_TOKEN], env: { AEOLUS_FOLDER: windowsFolder } });

    const { stdout } = hook(payloadFor(windowsFolder));

    expect(hookOutputSchema.parse(JSON.parse(stdout)).hookSpecificOutput.additionalContext).toContain('crews the Aeolus ship scout');
  });
});
