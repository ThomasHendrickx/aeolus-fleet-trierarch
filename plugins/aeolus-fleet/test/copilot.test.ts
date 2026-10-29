/**
 * The aeolus-fleet plugin in the GitHub Copilot CLI (S3 of the Cursor and
 * Copilot design): its manifest, marketplace and hooks file, and the shared
 * scripts run as Copilot runs a hook. Copilot runs the hooks file's
 * PascalCase events with Claude Code's snake_case payloads, and sets
 * PLUGIN_ROOT, CLAUDE_PLUGIN_ROOT, CLAUDE_PLUGIN_DATA and CLAUDE_PROJECT_DIR
 * in every hook, as captured on Copilot CLI 1.0.105.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  it('publishes the aeolus-fleet plugin through a Copilot manifest with its own hooks file and the crew skill, at the version of the other manifests', () => {
    const claude = z.object({ version: z.string() }).parse(json(join(PLUGIN, '.claude-plugin/plugin.json')));
    const manifest = z
      .object({ name: z.literal('aeolus-fleet'), version: z.string(), hooks: z.literal('./hooks/copilot-hooks.json'), skills: z.literal('./skills/crew-a-ship') })
      .parse(json(join(PLUGIN, '.github/plugin/plugin.json')));

    expect(manifest.version).toBe(claude.version);
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

  it('confirms a hand-over at the first tool call and marks the launch active at PreToolUse, and records the model at a Bash call', () => {
    const preToolUse = copilotHooks().PreToolUse ?? [];

    expect(preToolUse.map((entry) => [entry.matcher, entry.bash])).toEqual([
      [undefined, running('aeolus-handover.sh')],
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

  it('says nothing in a folder that crews no ship', async () => {
    await expect(copilotHook('aeolus-session-start.sh', { payload: { hook_event_name: 'SessionStart', source: 'new' } })).resolves.toMatchObject({ status: 0, stdout: '' });
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

  it('lets a turn with nothing unconfirmed end, idle, without asking for a watcher or arming a Codex wake bridge', async () => {
    crew();

    const stopped = await copilotHook('aeolus-stop.sh', { payload: { hook_event_name: 'Stop', stop_hook_active: false, stop_reason: 'end_turn' } });

    expect(stopped).toMatchObject({ status: 0, stdout: '' });
    expect(inSession('aeolus-identity.sh', { args: ['turn'] }).stdout).toMatch(/^idle /);
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
