import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NO_TERMINAL_QUESTIONS, type ShipId, type TrierarchConfiguration } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIGURATION, newId } from '../../test/support/in-memory.js';
import { COPILOT_ADAPTER_FLAGS, copilotSessionIdOf, copilotTurnCommand, createCopilotHarness } from './copilot.js';
import { runCommand } from './run-command.js';

// With the aeolus-fleet plugin's own scripts from this repository, in a temporary data folder standing for Copilot's.

const PLUGIN_ROOT = fileURLToPath(new URL('../../../../plugins/aeolus-fleet', import.meta.url));

const WITH_COPILOT: TrierarchConfiguration = {
  ...CONFIGURATION,
  harnesses: {
    copilot: {
      flags: ['--disable-builtin-mcps'],
      options: { model: { values: { luna: ['--model', 'gpt-6-luna'], auto: ['--model', 'auto'] }, default: 'auto' } },
    },
  },
};

/** Copilot's real output from `copilot -p --output-format json` (test/logs), captured from Copilot CLI 1.0.105 on 29 Oct, its stderr lines as the hold keeps them. */
const eventsOf = (file: string) =>
  readFileSync(new URL(`../../test/logs/${file}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line !== '');

/** The session id Copilot named in the interrupted turn's result. */
const INTERRUPTED_SESSION = '0b3b53ed-82c2-4bf7-a0e0-71f2c2d404e2';

let data: string;
let crews: string;
let folder: string;
let started: { shipId: ShipId; folder: string; command: readonly string[]; harness: string; env?: Readonly<Record<string, string>> }[];
let events: Map<ShipId, readonly string[]>;
let sent: { shipId: ShipId; line: string }[];
let steps: string[];

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'trierarch-copilot-plugin-data-'));
  crews = join(mkdtempSync(join(tmpdir(), 'trierarch-copilot-home-')), '.aeolus', 'crews', 'copilot');
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'trierarch-copilot-session-')));
  started = [];
  sent = [];
  steps = [];
  events = new Map();
});

afterEach(() => {
  rmSync(data, { recursive: true, force: true });
  rmSync(dirname(dirname(dirname(crews))), { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
});

function harness(at: { pluginRoot?: string; version?: string; isInContainer?: boolean; copilotHome?: string } = {}) {
  return createCopilotHarness({
    configuration: WITH_COPILOT,
    plugin: { root: () => Promise.resolve(at.pluginRoot ?? PLUGIN_ROOT), data, crews },
    detectedVersion: () => ('version' in at ? at.version : '1.0.105'),
    isInContainer: at.isInContainer ?? false,
    ...(at.copilotHome !== undefined && { copilotHome: at.copilotHome }),
    sessions: {
      start: (session) => {
        started.push(session);
        return Promise.resolve();
      },
      send: (sending) => {
        sent.push(sending);
        steps.push(`send ${sending.shipId}`);
        return Promise.resolve();
      },
      interrupt: (shipId) => {
        steps.push(`interrupt ${shipId}`);
        return Promise.resolve();
      },
      events: (shipId) => Promise.resolve(events.get(shipId) ?? []),
    },
  });
}

const shipId = newId('ship');
const LAUNCH_ID = 'launch-1';
const launchOf = (ship: ShipId) => ({ shipId: ship, shipName: 'scout', folder, harness: 'copilot', workspace: { kind: 'worktree', repository: 'aeolus-fleet' }, checkouts: [], launchId: LAUNCH_ID, login: 'subscription' }) as const;
const ADAPTER_WORDS = ['--output-format=json', '--allow-all-tools', '--no-ask-user'];

describe('Copilot as a harness: a turn per process (CC4)', () => {
  it('starts copilot -p with its output as JSON, every tool allowed and no question tool, behind the configured flags and the picked model, the first prompt last, ending in the line that no human reads its terminal', async () => {
    await harness().launch({ ...launchOf(shipId), options: { model: 'luna' }, isFirstStart: true, firstPrompt: 'Review the open pull requests.' });

    expect(started).toEqual([
      { shipId, folder, harness: 'copilot', env: { AEOLUS_LAUNCH: LAUNCH_ID }, command: ['copilot', '--disable-builtin-mcps', '--model', 'gpt-6-luna', ...ADAPTER_WORDS, `--prompt=Review the open pull requests.\n\n${NO_TERMINAL_QUESTIONS}`] },
    ]);
  });

  it('passes a first prompt that starts with - as the value of --prompt, so it never reads as a flag', async () => {
    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: true, firstPrompt: '-v' });

    expect(started[0]?.command.at(-1)).toBe(`--prompt=-v\n\n${NO_TERMINAL_QUESTIONS}`);
  });

  it("resumes on a restart the session its last turn named, by its id, since Copilot's --continue takes the machine's latest session of any folder", async () => {
    events.set(shipId, eventsOf('copilot-events-interrupted.jsonl'));

    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: false });

    expect(started[0]?.command).toEqual(['copilot', '--disable-builtin-mcps', '--model', 'auto', ...ADAPTER_WORDS, `--resume=${INTERRUPTED_SESSION}`, expect.stringMatching(/^--prompt=.+/su)]);
  });

  it('starts a new session on a restart when no turn named one, as when Copilot refused to resume the last', async () => {
    events.set(shipId, eventsOf('copilot-events-resume-refused.jsonl'));

    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: false });

    expect(started[0]?.command.some((word) => word.startsWith('--resume'))).toBe(false);
  });

  it('wakes a restarted session with a prompt to go on crewing its ship, never the first prompt again, the line that no human reads its terminal after it', async () => {
    await harness().launch({ ...launchOf(shipId), options: {}, isFirstStart: false, firstPrompt: 'Review the open pull requests.' });

    const prompt = started[0]?.command.at(-1) ?? '';
    expect({ isFirstPrompt: prompt.includes('Review the open pull requests.'), isEnding: prompt.endsWith(` ${NO_TERMINAL_QUESTIONS}`) }).toEqual({ isFirstPrompt: false, isEnding: true });
  });

  it("gives the session the trierarch's COPILOT_HOME, where its login and plugin are, when it has one", async () => {
    await harness({ copilotHome: '/srv/copilot' }).launch({ ...launchOf(shipId), options: {}, isFirstStart: true });

    expect(started[0]?.env).toEqual({ AEOLUS_LAUNCH: LAUNCH_ID, COPILOT_HOME: '/srv/copilot' });
  });

  it('starts nothing on an API key: Copilot signs in with the machine\'s own login (CC6)', async () => {
    await expect(harness().launch({ ...launchOf(shipId), login: 'apiKey', options: {}, isFirstStart: true })).rejects.toThrow("Copilot signs in with this computer's own login");
    expect(started).toEqual([]);
  });

  it('tells the configured flags from the ones the adapter adds to every launch', () => {
    expect(COPILOT_ADAPTER_FLAGS.map((each) => each.flag)).toEqual(ADAPTER_WORDS);
  });

  it("resumes the session for a later turn by its id, the start's flags kept and the line as the prompt", () => {
    const start = ['copilot', '--model', 'gpt-6-luna', ...ADAPTER_WORDS, '--prompt=Review the open pull requests.'];

    expect(copilotTurnCommand({ start, sessionId: 'session-1', line: '--the hand-over' })).toEqual(['copilot', '--model', 'gpt-6-luna', ...ADAPTER_WORDS, '--resume=session-1', '--prompt=--the hand-over']);
  });

  it('resumes the session for a later turn after a restart by the id the hold names, never the one the restart resumed', () => {
    const start = ['/usr/bin/node', 'copilot.js', ...ADAPTER_WORDS, '--resume=session-1', '--prompt=wake'];

    expect(copilotTurnCommand({ start, sessionId: 'session-2', line: 'next' })).toEqual(['/usr/bin/node', 'copilot.js', ...ADAPTER_WORDS, '--resume=session-2', '--prompt=next']);
  });

  it("reads the session's id from the result that ends each turn, the only event that names it", () => {
    expect(eventsOf('copilot-events-interrupted.jsonl').flatMap((line) => copilotSessionIdOf(line) ?? [])).toEqual([INTERRUPTED_SESSION]);
  });

  it('hands a message over through the plugin, and sends the line it prints as the next turn, with the line that no human reads its terminal', async () => {
    const line = "Aeolus handed a message for scout to this session: it comes into this turn through the plugin's hooks, acknowledged. Do not receive or ack it.";
    const root = mkdtempSync(join(data, 'plugin-'));
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts', 'aeolus-push.sh'), `[ "$1" = hand ] || exit 2\necho "${line}"\n`);

    await expect(harness({ pluginRoot: root }).handOver({ shipId, folder })).resolves.toBe('handed');

    expect(sent).toEqual([{ shipId, line: `${line} ${NO_TERMINAL_QUESTIONS}` }]);
  });

  it("forces a message over to a busy turn: the plugin's force hands it, then the turn is stopped and the line sent (decision 0040)", async () => {
    const root = mkdtempSync(join(data, 'plugin-'));
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts', 'aeolus-push.sh'), '[ "$1" = force ] || exit 2\necho "forced"\n');

    await expect(harness({ pluginRoot: root }).forceOver({ shipId, folder, isTurnBusy: true })).resolves.toBe('handed');

    expect(steps).toEqual([`interrupt ${shipId}`, `send ${shipId}`]);
  });
});

describe('where the machine offers Copilot (CC3, CC10)', () => {
  it('offers it on the host on the build its plugin is proven on', async () => {
    await expect(harness().notOfferedReason()).resolves.toBeUndefined();
  });

  it('does not offer a build its plugin is not proven on, naming the proven one', async () => {
    await expect(harness({ version: '1.0.106' }).notOfferedReason()).resolves.toBe('Copilot CLI 1.0.106 is not proven: the hooks of its aeolus-fleet plugin are proven on Copilot CLI 1.0.105');
  });

  it('does not offer it before detection named its version', async () => {
    await expect(harness({ version: undefined }).notOfferedReason()).resolves.toBe('its Copilot CLI version is not detected yet: the hooks of its aeolus-fleet plugin are proven on Copilot CLI 1.0.105');
  });

  it('does not offer it on the container runtime', async () => {
    await expect(harness({ isInContainer: true }).notOfferedReason()).resolves.toBe('Copilot is not proven in a container: the container runtime runs claude-code only');
  });
});

describe("Copilot's launch window, from the launch marker its session's hooks keep and its captured output (headless H13)", () => {
  async function hooked(payload: Record<string, unknown>, launchId = LAUNCH_ID): Promise<void> {
    const marked = await runCommand('bash', {
      args: [`${PLUGIN_ROOT}/scripts/aeolus-launch.sh`],
      env: { AEOLUS_FOLDER: folder, AEOLUS_DATA: data, AEOLUS_CREWS: crews, AEOLUS_LAUNCH: launchId, AEOLUS_HARNESS: 'copilot' },
      input: JSON.stringify({ cwd: folder, ...payload }),
    });
    expect(marked.status).toBe(0);
  }

  const identity = { fleetUrl: 'https://fleet.example.com', shipId, shipName: 'scout', socket: `/home/thomas/.aeolus/trierarch/sockets/${shipId}/fleet.sock` };
  const seen = (model?: string) => harness().launchSeen({ shipId, folder, launchId: LAUNCH_ID, ...(model !== undefined && { model }) });

  beforeEach(async () => {
    await harness().prepareIdentity({ folder, identity, crewToken: 'aeolus_ct_v1_of_the_crew' });
  });

  it('sees activity once the hooks marked a tool call of its launch', async () => {
    events.set(shipId, eventsOf('copilot-events-interrupted.jsonl'));
    await hooked({ hook_event_name: 'SessionStart', source: 'new' });
    await hooked({ hook_event_name: 'PreToolUse', tool_name: 'bash' });

    await expect(seen()).resolves.toEqual({ kind: 'active' });
  });

  it('sees the model it launched with refused, as Copilot says it on stderr before any hook runs', async () => {
    events.set(shipId, eventsOf('copilot-events-refused-model.jsonl'));

    await expect(seen('no-such-model')).resolves.toEqual({ kind: 'refused', model: 'no-such-model' });
  });

  it('reads no refusal of another model than the one it launched with, and names it as the cause', async () => {
    events.set(shipId, eventsOf('copilot-events-refused-model.jsonl'));

    await expect(seen('gpt-6-luna')).resolves.toEqual({ kind: 'none', cause: 'Model "no-such-model" from --model flag is not available.' });
  });

  it('names a missing or refused login as the cause, from the error Copilot writes before its first turn (CC6)', async () => {
    events.set(shipId, eventsOf('copilot-events-no-login.jsonl'));

    await expect(seen()).resolves.toEqual({ kind: 'none', cause: 'Authentication failed (Request ID: E292:132E5:18CFA4D:1A2BF0B:6AE39552)' });
  });

  it('names the session error of a turn whose model call failed as the cause', async () => {
    events.set(shipId, eventsOf('copilot-events-model-failed.jsonl'));

    await expect(seen()).resolves.toEqual({ kind: 'none', cause: 'Could not connect to local model provider at http://127.0.0.1:9/v1.\n  Check that the service is running and the port is correct.' });
  });

  it('names a session Copilot refused to resume as the cause', async () => {
    events.set(shipId, eventsOf('copilot-events-resume-refused.jsonl'));

    await expect(seen()).resolves.toEqual({ kind: 'none', cause: "No session, task, or name matched '00000000-0000-4000-8000-000000000000'." });
  });

  it('names no cause when its turn ended without an error', async () => {
    events.set(shipId, eventsOf('copilot-events-interrupted.jsonl'));

    await expect(seen()).resolves.toEqual({ kind: 'none' });
  });

  it('says its aeolus-fleet plugin marks launches', async () => {
    await expect(harness().marksLaunches()).resolves.toBe(true);
  });
});
