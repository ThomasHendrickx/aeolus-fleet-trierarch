/**
 * The aeolus-fleet plugin in the GitHub Copilot CLI (S3 of the Cursor and
 * Copilot design): its manifest, marketplace and hooks file, and the shared
 * scripts run as Copilot runs a hook. Copilot runs the hooks file's
 * PascalCase events with Claude Code's snake_case payloads, and sets
 * PLUGIN_ROOT, CLAUDE_PLUGIN_ROOT, CLAUDE_PLUGIN_DATA and CLAUDE_PROJECT_DIR
 * in every hook, as captured on Copilot CLI 1.0.105.
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { scriptEnvironment } from './script-environment.js';
import { startRoutedStubFleet, type StubAnswer, type StubFleet } from './stub-fleet.js';

const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const REPOSITORY = fileURLToPath(new URL('../../..', import.meta.url));
const SCRIPTS = join(PLUGIN, 'scripts');
const CREW_TOKEN = 'aeolus_ct_v1_crew';
const SHIP_ID = 'shp_01m3tbfspe96yf1rnr4ank9h1a';
const SESSION_ID = '1161b254-d09b-405e-8ca2-15a680ce4aa7';
const DELIVERY_ID = 'dlv_01m4raygfdtsjfbnmpvqjznsyw';
const MESSAGE_ID = 'msg_01m4raygfdtsjfbnmpvqjznsyv';
const NO_WAITS = { AEOLUS_BUSY_WAITS: '0 0 0 0' };

let data: string;
let folder: string;
/** A throwaway home: the identities and Copilot's session state live under it, never in the real one. */
let home: string;
let fleet: StubFleet | undefined;

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'aeolus-copilot-data-'));
  home = mkdtempSync(join(tmpdir(), 'aeolus-copilot-home-'));
  folder = mkdtempSync(join(tmpdir(), 'aeolus copilot folder-'));
});

afterEach(async () => {
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

function json(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** What the hooks file sets in every Copilot hook, over what Copilot itself sets there. */
const COPILOT_HOOK = (): Record<string, string> => ({
  AEOLUS_HARNESS: 'copilot',
  PLUGIN_ROOT: PLUGIN,
  CLAUDE_PLUGIN_ROOT: PLUGIN,
  CLAUDE_PLUGIN_DATA: data,
  CLAUDE_PROJECT_DIR: folder,
  AEOLUS_FOLDER: '',
  AEOLUS_DATA: '',
});

/** Runs a script as a Copilot session's command does, with what the SessionStart context names set. */
function inSession(script: string, options: { args?: string[]; stdin?: string; env?: Record<string, string> } = {}): Run {
  const result = spawnSync('bash', [join(SCRIPTS, script), ...(options.args ?? [])], {
    cwd: folder,
    input: options.stdin ?? '',
    encoding: 'utf8',
    env: scriptEnvironment({ HOME: home, AEOLUS_HARNESS: 'copilot', AEOLUS_DATA: data, AEOLUS_FOLDER: folder, AEOLUS_RETRY_SECONDS: '0', ...options.env }),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Runs a script as a Copilot session's command does, beside the stub fleet it may call. */
function inSessionInBackground(script: string): Promise<Run> {
  const child = spawn('bash', [join(SCRIPTS, script)], {
    cwd: folder,
    env: scriptEnvironment({ HOME: home, AEOLUS_HARNESS: 'copilot', AEOLUS_DATA: data, AEOLUS_FOLDER: folder, AEOLUS_RETRY_SECONDS: '0', AEOLUS_POLL_SECONDS: '0' }),
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((resolve) => {
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

/** A process named as the watcher, its pid where the plugin looks for the folder's watcher. */
function aRunningWatcher() {
  const bin = join(data, 'bin');
  mkdirSync(bin, { recursive: true });
  const watcher = join(bin, 'aeolus-wait.sh');
  writeFileSync(watcher, '#!/usr/bin/env bash\nsleep 30\n');
  chmodSync(watcher, 0o700);
  const process = spawn('bash', [watcher]);
  writeFileSync(inSession('aeolus-identity.sh', { args: ['path'] }).stdout.trim().replace(/\.identity$/, '.watch.pid'), `${String(process.pid)}\n`);
  return process;
}

/** Runs a hook as Copilot does: the payload on stdin, Copilot's variables and the hooks file's set, beside the stub fleet it may call. */
function copilotHook(script: string, { payload, env = {} }: { payload: Record<string, unknown>; env?: Record<string, string> }): Promise<Run> {
  const child = spawn('bash', [join(SCRIPTS, script)], {
    cwd: folder,
    env: scriptEnvironment({ HOME: home, ...COPILOT_HOOK(), ...NO_WAITS, ...env }),
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdin.end(JSON.stringify({ session_id: SESSION_ID, timestamp: '2026-10-29T18:20:23.851Z', cwd: folder, ...payload }));
  return new Promise((resolve) => {
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function crew(fleetUrl = 'https://fleet.example.com', args: string[] = []): void {
  expect(inSession('aeolus-identity.sh', { args: ['write', ...args, fleetUrl, SHIP_ID, 'scout'], stdin: CREW_TOKEN }).status).toBe(0);
}

/** A delivery as the fleet's receive answers it. */
function aDelivery() {
  return {
    deliveryId: DELIVERY_ID,
    messageId: MESSAGE_ID,
    senderShipId: 'shp_01m4ajt7abh4rypkmdnjene67g',
    senderName: 'orchestrator-1',
    senderType: 'orchestrator',
    recipient: { kind: 'ship', shipId: SHIP_ID },
    payload: 'Review PR 12',
    contentType: 'text/plain',
    model: 'claude-opus-5-5',
    inReplyTo: null,
    sentAt: '2026-10-12T15:15:54.467Z',
    attempts: 1,
  };
}

const taken: StubAnswer = { status: 200, body: {} };

/** A Copilot session the trierarch crews, handed one message by aeolus-push.sh hand, as the trierarch hands it over. */
async function aHandedMessage(): Promise<StubFleet> {
  const stub = await startRoutedStubFleet({
    '/api/v1/ship/pushReceive': [{ status: 200, body: { deliveries: [aDelivery()] } }],
    '/api/v1/ship/handed': [{ status: 200, body: { state: 'handed' } }],
    '/api/v1/ship/ack': [taken],
    '/api/v1/ship/handled': [taken],
    '/api/v1/ship/turn': [taken],
    '/api/v1/ship/notHandled': [taken],
  });
  fleet = stub;
  crew(stub.url, ['--wake-by', 'trierarch']);
  const handed = await new Promise<number | null>((resolve) => {
    const child = spawn('bash', [join(SCRIPTS, 'aeolus-push.sh'), 'hand'], {
      cwd: folder,
      env: scriptEnvironment({ HOME: home, AEOLUS_HARNESS: 'copilot', AEOLUS_DATA: data, AEOLUS_FOLDER: folder, ...NO_WAITS }),
    });
    child.on('close', resolve);
  });
  expect(handed).toBe(0);
  return stub;
}

const callsTo = (stub: StubFleet, path: string) => stub.calls.filter((call) => call.path === path);

const hookSchema = z.object({ type: z.literal('command'), bash: z.string(), env: z.record(z.string(), z.string()), timeoutSec: z.number().optional() });
const copilotHooks = () =>
  z
    .object({ version: z.literal(1), hooks: z.record(z.string(), z.array(hookSchema.extend({ matcher: z.string().optional() }))) })
    .parse(json(join(PLUGIN, 'hooks/copilot-hooks.json'))).hooks;
const running = (script: string) => `bash "\${PLUGIN_ROOT}/scripts/${script}"`;

describe('the Copilot plugin package (CC5)', () => {
  it('publishes the aeolus-fleet plugin through a Copilot manifest with its own hooks file, the crew-a-ship skill and the Copilot crew skill, at the version of the other manifests', () => {
    const claude = z.object({ version: z.string() }).parse(json(join(PLUGIN, '.claude-plugin/plugin.json')));
    const manifest = z
      .object({
        name: z.literal('aeolus-fleet'),
        version: z.string(),
        hooks: z.literal('./hooks/copilot-hooks.json'),
        skills: z.tuple([z.literal('./skills/crew-a-ship'), z.literal('./copilot-skills/crew')]),
      })
      .parse(json(join(PLUGIN, '.github/plugin/plugin.json')));

    expect(manifest.version).toBe(claude.version);
  });

  it("loads none of the Claude Code commands, which crew for Claude Code, as Copilot skills", () => {
    expect(z.object({ commands: z.array(z.string()) }).parse(json(join(PLUGIN, '.github/plugin/plugin.json'))).commands).toEqual([]);
  });

  it("lists the plugin in the repository's Copilot marketplace", () => {
    const marketplace = z
      .object({
        name: z.literal('aeolus-fleet'),
        owner: z.object({ name: z.string() }),
        plugins: z.array(z.object({ name: z.literal('aeolus-fleet'), source: z.literal('./plugins/aeolus-fleet'), description: z.string() })),
      })
      .parse(json(join(REPOSITORY, '.github/plugin/marketplace.json')));

    expect(marketplace.plugins).toHaveLength(1);
  });
});

describe("the Copilot hooks file: each role of the delivery protocol on the hook Copilot runs it with (the design's hook table)", () => {
  it('runs every hook with AEOLUS_HARNESS=copilot, so the scripts keep its crews in ~/.aeolus/crews/copilot though Copilot sets PLUGIN_ROOT as Codex does', () => {
    const entries = Object.values(copilotHooks()).flat();

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.env).toEqual({ AEOLUS_HARNESS: 'copilot' });
  });

  it('gives the start context and marks the launch started at SessionStart', () => {
    expect(copilotHooks().SessionStart?.map((entry) => entry.bash)).toEqual([running('aeolus-session-start.sh'), running('aeolus-launch.sh')]);
  });

  it('confirms a hand-over at the first tool call, guards the watcher and marks the launch active at PreToolUse, and records the model at a Bash call', () => {
    const preToolUse = copilotHooks().PreToolUse ?? [];

    expect(preToolUse.map((entry) => [entry.matcher, entry.bash])).toEqual([
      [undefined, running('aeolus-handover.sh')],
      ['^Bash$', running('aeolus-watch-guard.sh')],
      [undefined, running('aeolus-launch.sh')],
      ['^Bash$', running('aeolus-model.sh')],
    ]);
  });

  it('keeps the turn open with an unconfirmed message at Stop, reminds of the report at PostToolUse, and tells a died turn apart at SessionEnd', () => {
    const hooks = copilotHooks();

    expect(hooks.Stop?.map((entry) => entry.bash)).toEqual([running('aeolus-stop.sh')]);
    expect(hooks.PostToolUse?.map((entry) => entry.bash)).toEqual([running('aeolus-report-due.sh')]);
    expect(hooks.SessionEnd?.map((entry) => entry.bash)).toEqual([running('aeolus-turn-died.sh')]);
  });

  it('confirms nothing at the prompt, where Copilot drops what a hook adds (CC3), and leaves errorOccurred, which fires at every retried model call, unmapped', () => {
    expect(Object.keys(copilotHooks()).sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop']);
  });
});

describe('a Copilot crew in ~/.aeolus/crews/copilot (CC5)', () => {
  it("keeps the folder's identity in the Copilot crews folder, and a hook finds it there", async () => {
    crew();

    expect(inSession('aeolus-identity.sh', { args: ['path'] }).stdout).toContain(join(home, '.aeolus', 'crews', 'copilot'));
    const started = await copilotHook('aeolus-session-start.sh', { payload: { hook_event_name: 'SessionStart', source: 'new' } });
    expect(started.stdout).toContain('scout');
  });
});

describe('the SessionStart hook in Copilot', () => {
  const context = (hookRun: Run) => z.object({ additionalContext: z.string() }).parse(JSON.parse(hookRun.stdout)).additionalContext;

  it('uses the physical folder in Copilot instructions when the session starts through a link', async () => {
    const linkedFolder = join(home, 'copilot-session-folder');
    symlinkSync(folder, linkedFolder, 'dir');
    crew();

    const told = context(
      await copilotHook('aeolus-session-start.sh', {
        payload: { hook_event_name: 'SessionStart', source: 'new' },
        env: { CLAUDE_PROJECT_DIR: linkedFolder },
      }),
    );

    expect(told).toContain(`AEOLUS_FOLDER='${realpathSync(folder)}'`);
  });

  it("tells the session its ship and how to run the plugin's scripts, as top-level additionalContext, the form Copilot reads", async () => {
    crew();

    const told = context(await copilotHook('aeolus-session-start.sh', { payload: { hook_event_name: 'SessionStart', source: 'new' } }));

    expect(told).toContain(`This folder crews the Aeolus ship scout (${SHIP_ID}) in the fleet at https://fleet.example.com.`);
    expect(told).toContain(`AEOLUS_HARNESS=copilot AEOLUS_DATA='${data}' AEOLUS_FOLDER='${realpathSync(folder)}' "${PLUGIN}/scripts/aeolus-fleet.sh"`);
    expect(told).toContain('never read the identity file or pass a crew token');
  });

  it('tells a session the trierarch crews to start no watcher', async () => {
    crew('https://fleet.example.com', ['--wake-by', 'trierarch']);

    const told = context(await copilotHook('aeolus-session-start.sh', { payload: { hook_event_name: 'SessionStart', source: 'resume' } }));

    expect(told).toContain('The trierarch wakes this session when work arrives: start no watcher.');
  });

  it("tells a session in a folder that crews no ship that the hooks are active, and how to run the plugin's scripts, for the Copilot crew line (S6)", async () => {
    const told = context(await copilotHook('aeolus-session-start.sh', { payload: { hook_event_name: 'SessionStart', source: 'new' } }));

    expect(told).toBe(
      `Aeolus Fleet Copilot hooks are active. This folder crews no Aeolus ship. Run every Aeolus Fleet script with AEOLUS_HARNESS=copilot AEOLUS_DATA='${data}' AEOLUS_FOLDER='${realpathSync(folder)}' before it; the scripts are in ${PLUGIN}/scripts.`,
    );
  });

  it('tells a crewed session that the hooks are active too, so the Copilot crew skill finds its folder crewed (S6)', async () => {
    crew();

    const told = context(await copilotHook('aeolus-session-start.sh', { payload: { hook_event_name: 'SessionStart', source: 'new' } }));

    expect(told).toMatch(/^Aeolus Fleet Copilot hooks are active\. This folder crews the Aeolus ship scout/);
  });
});

describe('a hand-over in Copilot (CC3)', () => {
  it('confirms a handed message at the first tool call: acks it, then denies the call with the message as its reason', async () => {
    const stub = await aHandedMessage();

    const denied = await copilotHook('aeolus-handover.sh', { payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } } });

    expect(callsTo(stub, '/api/v1/ship/ack').map((call) => call.body)).toEqual([`{"deliveryId":"${DELIVERY_ID}"}`]);
    const reason = z.object({ hookSpecificOutput: z.object({ permissionDecision: z.literal('deny'), permissionDecisionReason: z.string() }) }).parse(JSON.parse(denied.stdout))
      .hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain('Review PR 12');
  });

  it('confirms a handed message at Stop when the turn called no tool, keeping the turn open with it', async () => {
    const stub = await aHandedMessage();

    const stopped = await copilotHook('aeolus-stop.sh', { payload: { hook_event_name: 'Stop', stop_hook_active: false, stop_reason: 'end_turn' } });

    expect(callsTo(stub, '/api/v1/ship/ack')).toHaveLength(1);
    const kept = z.object({ decision: z.literal('block'), reason: z.string() }).parse(JSON.parse(stopped.stdout));
    expect(kept.reason).toContain('Review PR 12');
    expect(kept.reason).not.toContain('aeolus-wait.sh');
  });

  it('lets a turn with nothing unconfirmed end, idle, without arming a Codex wake bridge, while a watcher runs', async () => {
    crew();
    const watcher = aRunningWatcher();

    const stopped = await copilotHook('aeolus-stop.sh', { payload: { hook_event_name: 'Stop', stop_hook_active: false, stop_reason: 'end_turn' } });

    watcher.kill();
    expect(stopped).toMatchObject({ status: 0, stdout: '' });
    expect(inSession('aeolus-identity.sh', { args: ['turn'] }).stdout).toMatch(/^idle /);
  });
});

describe('a Copilot session crewed by hand wakes through the watcher, a detached background shell whose completion starts a turn (CC12)', () => {
  const START_THE_WATCHER = () =>
    `start AEOLUS_HARNESS=copilot AEOLUS_DATA='${data}' AEOLUS_FOLDER='${realpathSync(folder)}' "${PLUGIN}/scripts/aeolus-wait.sh" as a detached background shell (the shell tool with mode async and detach true), then end your turn`;
  const theTurnEnding = (wasKeptOpen = false) =>
    copilotHook('aeolus-stop.sh', { payload: { hook_event_name: 'Stop', stop_hook_active: wasKeptOpen, stop_reason: 'end_turn' } });
  const kept = (hookRun: Run) => z.object({ decision: z.literal('block'), reason: z.string() }).parse(JSON.parse(hookRun.stdout)).reason;
  /** The shell tool call that starts the watcher, as Copilot CLI 1.0.105 makes it. */
  const startingTheWatcher = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: `AEOLUS_HARNESS=copilot "${SCRIPTS}/aeolus-wait.sh"`, description: 'Start the Aeolus watcher', mode: 'async', detach: true },
  };
  const deniedWith = (hookRun: Run) =>
    z.object({ hookSpecificOutput: z.object({ permissionDecision: z.literal('deny'), permissionDecisionReason: z.string() }) }).parse(JSON.parse(hookRun.stdout))
      .hookSpecificOutput.permissionDecisionReason;

  it('keeps the turn open once when no watcher runs, asking for the watcher as a detached background shell with the variables its scripts run with', async () => {
    crew();

    const stopped = await theTurnEnding();

    expect(kept(stopped)).toBe(`aeolus: no watcher runs for scout, so nothing wakes this session when work arrives: ${START_THE_WATCHER()}`);
  });

  it('lets the turn end, idle, when it already kept it open once', async () => {
    crew();

    const stopped = await theTurnEnding(true);

    expect(stopped).toMatchObject({ status: 0, stdout: '' });
    expect(inSession('aeolus-identity.sh', { args: ['turn'] }).stdout).toMatch(/^idle /);
  });

  it('confirms a message the watcher handed over at Stop when the turn called no tool, asking for the watcher again with it', async () => {
    const stub = await startRoutedStubFleet({
      '/api/v1/ship/inbox': [{ status: 200, body: { waiting: 1, forced: 0 } }],
      '/api/v1/ship/pushReceive': [{ status: 200, body: { deliveries: [aDelivery()] } }],
      '/api/v1/ship/handed': [{ status: 200, body: { state: 'handed' } }],
      '/api/v1/ship/ack': [taken],
      '/api/v1/ship/turn': [taken],
    });
    fleet = stub;
    crew(stub.url);
    await theTurnEnding(true);
    await expect(inSessionInBackground('aeolus-wait.sh')).resolves.toMatchObject({ status: 0 });

    const stopped = await theTurnEnding();

    expect(callsTo(stub, '/api/v1/ship/ack').map((call) => call.body)).toEqual([`{"deliveryId":"${DELIVERY_ID}"}`]);
    expect(kept(stopped)).toContain('Review PR 12');
    expect(kept(stopped)).toContain(`aeolus: no watcher runs for scout: when you are done, ${START_THE_WATCHER()}`);
  });

  it('refuses to start a second watcher while one runs, so the session is not woken with nothing to read', async () => {
    crew();
    const watcher = aRunningWatcher();

    const guarded = await copilotHook('aeolus-watch-guard.sh', { payload: startingTheWatcher });

    watcher.kill();
    expect(deniedWith(guarded)).toBe('aeolus: already running: a watcher runs for scout; do nothing else');
  });

  it('lets the watcher start when none runs', async () => {
    crew();

    await expect(copilotHook('aeolus-watch-guard.sh', { payload: startingTheWatcher })).resolves.toMatchObject({ status: 0, stdout: '' });
  });

  it('refuses any watcher in a folder the trierarch crews, which wakes the session itself', async () => {
    crew('https://fleet.example.com', ['--wake-by', 'trierarch']);

    const guarded = await copilotHook('aeolus-watch-guard.sh', { payload: startingTheWatcher });

    expect(deniedWith(guarded)).toBe('aeolus: the trierarch wakes scout; start no watcher and do nothing else');
  });
});

describe('a died turn in Copilot: SessionEnd with reason error, abort or timeout', () => {
  it.each(['error', 'abort', 'timeout'])('marks the turn idle and keeps a confirmed message to hand once more when the session ends with %s', async (reason) => {
    const stub = await aHandedMessage();
    await copilotHook('aeolus-handover.sh', { payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } } });

    await copilotHook('aeolus-turn-died.sh', { payload: { hook_event_name: 'SessionEnd', reason } });

    expect(inSession('aeolus-identity.sh', { args: ['turn'] }).stdout).toMatch(/^idle /);
    expect(inSession('aeolus-identity.sh', { args: ['store'] }).stdout).toContain(`${DELIVERY_ID} onceMore`);
    expect(callsTo(stub, '/api/v1/ship/handled')).toEqual([]);
  });

  it.each(['complete', 'user_exit'])('takes a session that ends with %s for no died turn', async (reason) => {
    await aHandedMessage();
    await copilotHook('aeolus-handover.sh', { payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } } });

    await copilotHook('aeolus-turn-died.sh', { payload: { hook_event_name: 'SessionEnd', reason } });

    expect(inSession('aeolus-identity.sh', { args: ['store'] }).stdout).toContain(`${DELIVERY_ID} confirmed`);
  });
});

describe('the report reminder in Copilot', () => {
  it('reminds a squadron member as top-level additionalContext, the form Copilot reads', async () => {
    expect(inSession('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', SHIP_ID, 'scout', 'sqd_01m4w1t3c6m6q7v9hq0hq0q0q0'], stdin: CREW_TOKEN }).status).toBe(0);
    expect(inSession('aeolus-identity.sh', { args: ['check-in', '1m'] }).status).toBe(0);
    const reported = inSession('aeolus-identity.sh', { args: ['path'] }).stdout.trim().replace(/\.identity$/, '.reported');
    writeFileSync(reported, '1\n');

    const reminded = await copilotHook('aeolus-report-due.sh', { payload: { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } } });

    expect(z.object({ additionalContext: z.string() }).parse(JSON.parse(reminded.stdout)).additionalContext).toContain('the check-in interval of the squadron');
  });
});

describe('the model a Copilot session states (CC11)', () => {
  /** Copilot's own record of the session, as it keeps it under its home. */
  function sessionEvents(...events: Record<string, unknown>[]): void {
    const state = join(home, '.copilot', 'session-state', SESSION_ID);
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  }
  const aFleetCall = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `AEOLUS_HARNESS=copilot "${SCRIPTS}/aeolus-fleet.sh" send - <<'JSON'\n{}\nJSON` } };
  const recorded = () => readFileSync(inSession('aeolus-identity.sh', { args: ['path'] }).stdout.trim().replace(/\.identity$/, '.model'), 'utf8').trim();

  it('states auto for a session on auto mode, which picks its model per request', async () => {
    crew();
    sessionEvents(
      { type: 'session.start', data: { sessionId: SESSION_ID } },
      { type: 'session.model_change', data: { source: 'startup', newModel: 'auto' } },
      { type: 'session.auto_mode_resolved', data: { chosenModel: 'gpt-6-luna' } },
    );

    await copilotHook('aeolus-model.sh', { payload: aFleetCall });

    expect(recorded()).toBe('auto');
  });

  it('states the id a session started with --model or switched to names, the last one Copilot recorded', async () => {
    crew();
    sessionEvents(
      { type: 'session.model_change', data: { source: 'startup', newModel: 'auto' } },
      { type: 'session.resume', data: { selectedModel: 'gpt-6-luna' } },
    );

    await copilotHook('aeolus-model.sh', { payload: aFleetCall });

    expect(recorded()).toBe('gpt-6-luna');
  });

  it('reads the session from COPILOT_HOME when Copilot keeps its state there', async () => {
    crew();
    const copilotHome = join(home, 'elsewhere');
    mkdirSync(join(copilotHome, 'session-state', SESSION_ID), { recursive: true });
    writeFileSync(join(copilotHome, 'session-state', SESSION_ID, 'events.jsonl'), `${JSON.stringify({ type: 'session.model_change', data: { newModel: 'mai-code-1.1-flash' } })}\n`);

    await copilotHook('aeolus-model.sh', { payload: aFleetCall, env: { COPILOT_HOME: copilotHome } });

    expect(recorded()).toBe('mai-code-1.1-flash');
  });
});
