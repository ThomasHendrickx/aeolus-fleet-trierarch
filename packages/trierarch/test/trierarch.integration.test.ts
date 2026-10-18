import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ShipId } from '@aeolus-fleet/common';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

// The shared Postgres container's URL, which the global setup provides to every file.
import type {} from '../../core/test/postgres.global-setup.js';
import { createApp } from '../../core/src/app.js';
import { createPrismaClient, type PrismaClient } from '../../core/src/adapters/prisma/client.js';
import { createUseCases } from '../../core/src/wiring.js';
import { FLEET_URL, OPERATOR, operatorCaller, secretOf } from '../../core/test/support/core-fixtures.js';
import { createMigratedDatabase } from '../../core/test/support/database.js';
import { newKey } from '../../core/test/support/keys.js';
import { unwrap } from '../../core/test/support/result.js';
import { createClaudeCodeHarness } from '../src/adapters/claude-code.js';
import { adapterFlagsOf, riskyFlagsOf } from '../src/adapters/harnesses.js';
import { createClaudeCodeSetup } from '../src/adapters/claude-code-setup.js';
import { readCrewFile } from '../src/adapters/files.js';
import { runCommand } from '../src/adapters/run-command.js';
import { createGitWorkspace } from '../src/adapters/git-workspace.js';
import { createJsonState } from '../src/adapters/json-state.js';
import { trierarchPaths, type TrierarchPaths } from '../src/adapters/paths.js';
import { createRestFleet } from '../src/adapters/rest-fleet.js';
import { createTrust } from '../src/adapters/trust.js';
import { initTrierarch } from '../src/cli/init.js';
import type { ObservedSession, SessionRuntime } from '../src/core/ports.js';
import { RESTART_DELAYS_MS } from '../src/core/restart-policy.js';
import { createCallerCheck } from '../src/adapters/caller-check.js';
import { createShipSockets, type ShipSockets } from '../src/adapters/ship-sockets.js';
import { createRunPass } from '../src/core/run-pass.js';
import { CONFIGURATION } from './support/in-memory.js';
import { NO_TERMINAL_QUESTIONS } from '@aeolus-fleet/common';

// The trierarch against a real fleet server on Postgres, over REST: a crew
// request assigned to it is crewed in a worktree of a real git repository,
// with the folder's identity written through the aeolus plugin's own script,
// and removing the request ends the lease. Only the sessions are stand-ins:
// no Claude Code runs here, but its stand-in shows its first-run screens, as
// captured from Claude Code itself, until its own files say they are answered,
// and past them runs the aeolus plugin's own launch hook as its first prompt
// would: the session starts and makes a tool call (#490).

const PLUGIN_ROOT = fileURLToPath(new URL('../../../plugins/aeolus', import.meta.url));
const GIT_ENV = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' };

let database: PrismaClient;
let server: FastifyInstance;
let address: string;
let home: string;
let paths: TrierarchPaths;
/** The ships' sockets of the trierarch under test, closed after each test. */
let openSockets: ShipSockets | undefined;
let repository: string;
let pluginData: string;

const SKIP = '--dangerously-skip-permissions';

function claudeCodeScreen(name: string): string {
  return readFileSync(new URL(`./screens/claude-code-${name}.txt`, import.meta.url), 'utf8');
}

function jsonIn(path: string): Record<string, unknown> {
  return existsSync(path) ? z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(path, 'utf8'))) : {};
}

/**
 * The first-run screen Claude Code shows in the home folder (#403): its
 * onboarding until it is completed in ~/.claude.json, then, launched with
 * skip-permissions, its bypass permissions warning until that is accepted in
 * ~/.claude/settings.json; else none, and its first prompt runs.
 */
function claudeCodeStopsAt(command: readonly string[]): string | undefined {
  if (jsonIn(join(home, '.claude.json')).hasCompletedOnboarding !== true) {
    return claudeCodeScreen('theme');
  }
  if (command.includes(SKIP) && jsonIn(join(home, '.claude', 'settings.json')).skipDangerousModePermissionPrompt !== true) {
    return claudeCodeScreen('bypass');
  }
  return undefined;
}

function claudeCodeShows(command: readonly string[]): string {
  return claudeCodeStopsAt(command) ?? '❯ /aeolus:wake\n\n  Ran 1 shell command\n';
}

/** Runs the aeolus plugin's launch hook for each event, as Claude Code does in the session started in the folder with the launch id given. */
async function launchHooks(at: { folder: string; env: Readonly<Record<string, string>> }, events: readonly Record<string, unknown>[]): Promise<void> {
  for (const event of events) {
    const hooked = await runCommand('bash', {
      args: [`${PLUGIN_ROOT}/scripts/aeolus-launch.sh`],
      env: { ...at.env, AEOLUS_FOLDER: at.folder, AEOLUS_DATA: pluginData, AEOLUS_CREWS: join(home, '.aeolus', 'crews', 'claude-code') },
      input: JSON.stringify({ cwd: at.folder, transcript_path: join(home, 'transcript.jsonl'), ...event }),
    });
    expect(hooked.status, hooked.stderr).toBe(0);
  }
}

/** Sessions as a map, standing in for the session runtime: started ones run until stopped, each showing what Claude Code would show in this home. */
function standInSessions(): SessionRuntime {
  const sessions = new Map<ShipId, ObservedSession['status']>();
  const commands = new Map<ShipId, readonly string[]>();
  return {
    list: () => Promise.resolve([...sessions].map(([shipId, status]) => ({ shipId, status }))),
    stop: (shipId) => {
      sessions.delete(shipId);
      return Promise.resolve();
    },
    start: async ({ shipId, folder, command, env = {} }) => {
      sessions.set(shipId, 'running');
      commands.set(shipId, command);
      if (claudeCodeStopsAt(command) === undefined) {
        await launchHooks({ folder, env }, [{ hook_event_name: 'SessionStart', source: 'startup' }, { hook_event_name: 'PreToolUse', tool_name: 'Bash' }]);
      }
    },
    type: () => Promise.resolve(),
    interrupt: () => Promise.resolve(),
    screen: (shipId) => Promise.resolve(sessions.has(shipId) ? claudeCodeShows(commands.get(shipId) ?? []) : ''),
  };
}

async function git(args: string[]): Promise<void> {
  const result = await runCommand('git', { args, env: GIT_ENV });
  expect(result.status, result.stderr).toBe(0);
}

beforeEach(async () => {
  const databaseUrl = await createMigratedDatabase();
  database = createPrismaClient(databaseUrl);
  server = createApp({ databaseUrl, publicUrl: FLEET_URL, logger: false, receiveWaitMs: 100 });
  address = await server.listen({ host: '127.0.0.1', port: 0 });
  home = realpathSync(mkdtempSync(join(tmpdir(), 'trierarch-home-')));
  paths = trierarchPaths({ homeDirectory: home });
  repository = join(home, 'aeolus-fleet');
  await git(['init', '-q', '-b', 'main', repository]);
  writeFileSync(join(repository, 'README.md'), 'hello\n');
  await git(['-C', repository, 'add', '.']);
  await git(['-C', repository, 'commit', '-q', '-m', 'init']);
  mkdirSync(join(home, 'notes'));
  pluginData = join(home, 'plugin-data');
});

afterEach(async () => {
  await openSockets?.closeAll();
  openSockets = undefined;
  await server.close();
  await database.$disconnect();
  rmSync(home, { recursive: true, force: true });
});

/** A trierarch set up with init on a real fleet, with a ship scout of the fleet to crew, and one pass of its loop; Claude Code with the flags given. */
async function aTrierarchOnTheFleet(claudeCodeFlags: readonly string[] = CONFIGURATION.harnesses['claude-code']?.flags ?? [], at: { sessions?: SessionRuntime; clock?: { now: () => Date } } = {}) {
  const useCases = createUseCases({ prisma: database });
  const argo = operatorCaller(unwrap(await useCases.initialiseFleet({ name: 'home fleet', ...OPERATOR })));
  const trierarchShip = unwrap(await useCases.commissionShip(argo, { idempotencyKey: newKey(), name: 'mac-mini', type: 'trierarch', fleetScopes: ['crew:run'] }));
  const scout = unwrap(await useCases.commissionShip(argo, { idempotencyKey: newKey(), name: 'scout', type: 'reviewer' }));

  const service = { install: () => Promise.resolve(), rewrite: () => Promise.resolve(), restart: () => Promise.resolve(), status: () => Promise.resolve({ file: 'none', isInstalled: true, isRunning: true }) };
  // The places come with init, as an operator adds them: adding a place through init is what trusts it (#381).
  const configuration = {
    ...CONFIGURATION,
    harnesses: { 'claude-code': { options: {}, ...CONFIGURATION.harnesses['claude-code'], flags: [...claudeCodeFlags] } },
    repositories: { 'aeolus-fleet': { path: repository } },
    folders: { notes: { path: join(home, 'notes') } },
  };
  mkdirSync(dirname(paths.config), { recursive: true });
  writeFileSync(paths.config, JSON.stringify(configuration));
  const quiet = { text: () => Promise.reject(new Error('asked')), secret: () => Promise.reject(new Error('asked')), confirm: () => Promise.reject(new Error('asked')), say: () => undefined, step: () => undefined };
  await initTrierarch({
    homeDirectory: home,
    paths,
    flags: { fleetUrl: address, shipId: trierarchShip.shipId, secret: secretOf(trierarchShip.secret), isYes: true },
    prompter: quiet,
    fleetAt: (fleetUrl) => createRestFleet({ fleetUrl, crewToken: '' }),
    claudeCode: createClaudeCodeSetup({ homeDirectory: home, managedSettings: join(home, 'managed') }),
    codex: { trust: () => Promise.reject(new Error('no Codex here')), trustAeolusHooks: () => Promise.reject(new Error('no Codex here')) },
    isCodexInstalled: false,
    service,
    running: () => Promise.resolve(undefined),
    detect: () => Promise.resolve({}),
  });
  const fleet = createRestFleet(await readCrewFile(paths.crewToken));
  const sessions = at.sessions ?? standInSessions();
  const harness = createClaudeCodeHarness({ configuration, plugin: { root: () => Promise.resolve(PLUGIN_ROOT), data: pluginData, crews: join(home, '.aeolus', 'crews', 'claude-code') }, projects: join(home, '.claude', 'projects'), sessions, setup: createClaudeCodeSetup({ homeDirectory: home, managedSettings: join(home, 'managed') }), permissionModes: () => undefined });
  const workspace = createGitWorkspace({ configuration, root: paths.worktrees });
  const state = createJsonState(paths.state);
  const clock = at.clock ?? { now: () => new Date() };
  const logger = { warn: () => undefined, action: () => undefined };
  const setup = { configuration, version: '0.0.0', adapterFlags: adapterFlagsOf(configuration), riskyFlags: riskyFlagsOf(configuration) };
  // The real caller check: the plugin's scripts run as children of this process, as aeolus-push.sh does of the trierarch.
  const mayCall = createCallerCheck({ platform: process.platform, sessionRootOf: () => Promise.resolve(undefined) });
  const sockets = createShipSockets({ root: paths.sockets, fleetUrl: address, crewTokenOf: async (shipId) => (await state.load()).entries[shipId]?.crewToken, mayCall, log: () => undefined });
  openSockets = sockets;
  // A new run pass over the same files is the trierarch started again.
  const aRunPass = () => createRunPass({ fleet, harnesses: { 'claude-code': harness }, processes: sessions, workspace, trust: createTrust({ configuration, homeDirectory: home, env: {}, managedSettings: join(home, 'managed') }), state, setup, clock, logger, refuseModel: () => Promise.resolve(), newLaunchId: randomUUID, sockets });
  const pass = aRunPass();
  const leasesOf = (shipId: ShipId) => database.lease.count({ where: { shipId, endedAt: null } });
  const worktree = join(paths.worktrees, 'aeolus-fleet', 'scout');

  return { useCases, argo, trierarchShip, scout, pass, aRunPass, leasesOf, worktree, sockets };
}

describe('the trierarch on a real fleet', () => {
  it('crews an assigned request, its status reads running once its session shows activity, and removing it ends the lease, removes the clean worktree and the request', async () => {
    const { useCases, argo, trierarchShip, scout, pass, leasesOf, worktree } = await aTrierarchOnTheFleet();
    unwrap(await useCases.requestCrew(argo, { shipId: scout.shipId, settings: { harness: 'claude-code', workspace: { kind: 'worktree', repository: 'aeolus-fleet' }, options: {} } }));
    unwrap(await useCases.assignCrew(argo, { shipId: scout.shipId, trierarchShipId: trierarchShip.shipId }));
    await pass();
    await expect(database.crewRequest.findUniqueOrThrow({ where: { shipId: scout.shipId } })).resolves.toMatchObject({ status: 'crewing' });
    await pass();

    await expect(leasesOf(scout.shipId)).resolves.toBe(1);
    await expect(database.crewRequest.findUniqueOrThrow({ where: { shipId: scout.shipId } })).resolves.toMatchObject({ status: 'running' });
    expect(existsSync(join(worktree, 'README.md'))).toBe(true);
    const identityPath = await runCommand('bash', { args: [`${PLUGIN_ROOT}/scripts/aeolus-identity.sh`, 'path'], env: { AEOLUS_FOLDER: worktree, AEOLUS_DATA: pluginData, AEOLUS_CREWS: join(home, '.aeolus', 'crews', 'claude-code') } });
    const identity = readFileSync(identityPath.stdout.trim(), 'utf8');
    expect(identity).toContain(`shipId=${scout.shipId}\n`);
    expect(identity).toContain('wakeBy=trierarch\n');

    unwrap(await useCases.removeCrewRequest(argo, { shipId: scout.shipId }));
    await pass();

    await expect(leasesOf(scout.shipId)).resolves.toBe(0);
    expect(existsSync(worktree)).toBe(false);
    await expect(database.crewRequest.findUnique({ where: { shipId: scout.shipId } })).resolves.toBeNull();
  });

  it('on a fresh machine, where Claude Code never ran, crews its first session with no person: init answers its first-run screens and bypass permissions, and the session runs (#403)', async () => {
    expect(existsSync(join(home, '.claude.json'))).toBe(false);
    const { useCases, argo, trierarchShip, scout, pass } = await aTrierarchOnTheFleet([SKIP]);
    unwrap(await useCases.requestCrew(argo, { shipId: scout.shipId, settings: { harness: 'claude-code', workspace: { kind: 'worktree', repository: 'aeolus-fleet' }, options: {} } }));
    unwrap(await useCases.assignCrew(argo, { shipId: scout.shipId, trierarchShipId: trierarchShip.shipId }));

    await pass();
    await pass();

    await expect(database.crewRequest.findUniqueOrThrow({ where: { shipId: scout.shipId } })).resolves.toMatchObject({ status: 'running' });
  });

  it('removing the request removes a worktree with changes too and tells argo what it discards, so the ship crewed again starts in a fresh worktree (#450)', async () => {
    const { useCases, argo, trierarchShip, scout, pass, worktree } = await aTrierarchOnTheFleet();
    const settings = { harness: 'claude-code', workspace: { kind: 'worktree', repository: 'aeolus-fleet' }, options: {} };
    unwrap(await useCases.requestCrew(argo, { shipId: scout.shipId, settings }));
    unwrap(await useCases.assignCrew(argo, { shipId: scout.shipId, trierarchShipId: trierarchShip.shipId }));
    await pass();
    writeFileSync(join(worktree, 'draft.md'), 'work in progress\n');
    unwrap(await useCases.removeCrewRequest(argo, { shipId: scout.shipId }));
    await pass();
    expect(existsSync(worktree)).toBe(false);
    await expect(database.message.findMany({ where: { senderShipId: trierarchShip.shipId }, select: { payload: true, contentType: true } })).resolves.toEqual([
      {
        payload: `scout released: unpushed work discarded\n\n- Ship: scout (\`${scout.shipId}\`)\n- Worktree: aeolus-fleet\n- Discarded: 1 new\n\n- new \`draft.md\``,
        contentType: 'text/markdown',
      },
    ]);

    unwrap(await useCases.requestCrew(argo, { shipId: scout.shipId, settings }));
    unwrap(await useCases.assignCrew(argo, { shipId: scout.shipId, trierarchShipId: trierarchShip.shipId }));
    await pass();

    expect(existsSync(join(worktree, 'README.md'))).toBe(true);
    expect(existsSync(join(worktree, 'draft.md'))).toBe(false);
  });

  it('clears a kept worktree when argo asks, and confirms it removed it (#325, decision 0032)', async () => {
    const { useCases, argo, trierarchShip, scout, pass, worktree } = await aTrierarchOnTheFleet();
    unwrap(await useCases.requestCrew(argo, { shipId: scout.shipId, settings: { harness: 'claude-code', workspace: { kind: 'worktree', repository: 'aeolus-fleet' }, options: {} } }));
    unwrap(await useCases.assignCrew(argo, { shipId: scout.shipId, trierarchShipId: trierarchShip.shipId }));
    await pass();
    // A worktree with changes is kept when its crew is given back before it is final: settings this trierarch cannot crew come while it crews.
    writeFileSync(join(worktree, 'draft.md'), 'work in progress\n');
    unwrap(await useCases.requestCrew(argo, { shipId: scout.shipId, settings: { harness: 'codex', workspace: { kind: 'worktree', repository: 'aeolus-fleet' }, options: {} } }));
    await pass();
    expect(existsSync(worktree)).toBe(true);

    unwrap(await useCases.requestWorktreeClear(argo, { trierarchShipId: trierarchShip.shipId, shipId: scout.shipId, repository: 'aeolus-fleet' }));
    await pass();

    expect(existsSync(worktree)).toBe(false);
    await expect(useCases.readClearRequests(argo)).resolves.toEqual([]);
    await expect(database.event.findMany({ where: { type: 'WorktreeCleared' }, select: { details: true } })).resolves.toEqual([
      { details: { worktreeShipId: scout.shipId, repository: 'aeolus-fleet', outcome: 'removed' } },
    ]);
  });
});

describe("contained access on a real fleet (decision 0026): the session calls over its ship's socket, and only the trierarch holds the crew token", () => {
  const SETTINGS = { harness: 'claude-code', workspace: { kind: 'worktree', repository: 'aeolus-fleet' }, options: {} } as const;

  /** A fleet call of the session in the worktree, through the aeolus plugin's own script, as Claude Code's Bash tool makes it. */
  const fleetCall = (worktree: string, call: { args: readonly string[]; input?: string }) =>
    runCommand('bash', {
      args: [`${PLUGIN_ROOT}/scripts/aeolus-fleet.sh`, ...call.args],
      env: { HOME: home, AEOLUS_FOLDER: worktree, AEOLUS_DATA: pluginData, AEOLUS_CREWS: join(home, '.aeolus', 'crews', 'claude-code'), AEOLUS_BUSY_WAITS: '' },
      ...(call.input !== undefined && { input: call.input }),
    });

  /** The crew token the trierarch keeps for the ship in its state. */
  const crewTokenOf = (shipId: ShipId) => z.object({ entries: z.record(z.string(), z.object({ crewToken: z.string() }).partial()) }).parse(JSON.parse(readFileSync(paths.state, 'utf8'))).entries[shipId]?.crewToken;

  /** Every file the session's plugin keeps, its identity among them, and what each holds. */
  function sessionFiles(): string[] {
    const files: string[] = [];
    const walk = (folder: string) => {
      for (const entry of existsSync(folder) ? readdirSync(folder, { withFileTypes: true }) : []) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) {
          walk(path);
        } else if (entry.isFile()) {
          files.push(readFileSync(path, 'utf8'));
        }
      }
    };
    walk(join(home, '.aeolus', 'crews'));
    walk(pluginData);
    return files;
  }

  async function aCrewedScout() {
    const trierarch = await aTrierarchOnTheFleet();
    const { useCases, argo, trierarchShip, scout, pass } = trierarch;
    unwrap(await useCases.requestCrew(argo, { shipId: scout.shipId, settings: SETTINGS }));
    unwrap(await useCases.assignCrew(argo, { shipId: scout.shipId, trierarchShipId: trierarchShip.shipId }));
    await pass();
    return trierarch;
  }

  const eventsOf = async (shipId: ShipId) => (await database.event.findMany({ where: { shipId }, select: { type: true } })).map(({ type }) => type);

  it('sends, acks and reports over the socket, with no crew token in what the session keeps', async () => {
    const { useCases, argo, scout, worktree } = await aCrewedScout();
    const crewToken = crewTokenOf(scout.shipId);
    unwrap(await useCases.sendMessage(argo, { selector: { kind: 'ship', name: 'scout' }, payload: 'chart the coast', idempotencyKey: newKey() }));

    const sent = await fleetCall(worktree, { args: ['send', '-'], input: JSON.stringify({ selector: { kind: 'ship', name: 'argo' }, payload: 'on it', idempotencyKey: newKey(), model: 'claude-opus-5-5' }) });
    const received = await fleetCall(worktree, { args: ['receive'] });
    const [delivery] = z.object({ deliveries: z.array(z.object({ deliveryId: z.string() })) }).parse(JSON.parse(received.stdout)).deliveries;
    const acked = await fleetCall(worktree, { args: ['ack', delivery?.deliveryId ?? 'no delivery'] });
    const reported = await fleetCall(worktree, { args: ['report', '{"state":"working","note":"charting"}'] });

    expect([sent, received, acked, reported].map((call) => call.status)).toEqual([0, 0, 0, 0]);
    await expect(eventsOf(scout.shipId)).resolves.toEqual(expect.arrayContaining(['MessageAccepted', 'DeliveryAcknowledged', 'ShipReported']));
    expect(crewToken).toMatch(/^aeolus_ct_/);
    expect(sessionFiles().filter((file) => file.includes(crewToken ?? 'no crew token'))).toEqual([]);
  });

  it('gives a call no answer while the trierarch is down, and the fleet stores nothing', async () => {
    const { scout, worktree, sockets } = await aCrewedScout();
    await sockets.closeAll();

    const sent = await fleetCall(worktree, { args: ['send', '-'], input: JSON.stringify({ selector: { kind: 'ship', name: 'argo' }, payload: 'on it', idempotencyKey: newKey(), model: 'claude-opus-5-5' }) });

    expect(sent.status).toBe(6);
    await expect(database.message.count({ where: { senderShipId: scout.shipId } })).resolves.toBe(0);
  });

  it("gives the ship's new crew token to its same socket once the ship is crewed again", async () => {
    const { useCases, argo, trierarchShip, scout, pass, worktree } = await aCrewedScout();
    const first = crewTokenOf(scout.shipId);
    const socketOf = () => /^socket=(.*)$/m.exec(sessionFiles().join('\n'))?.[1];
    const socket = socketOf();
    unwrap(await useCases.removeCrewRequest(argo, { shipId: scout.shipId }));
    await pass();
    unwrap(await useCases.requestCrew(argo, { shipId: scout.shipId, settings: SETTINGS }));
    unwrap(await useCases.assignCrew(argo, { shipId: scout.shipId, trierarchShipId: trierarchShip.shipId }));
    await pass();

    const whoami = await fleetCall(worktree, { args: ['whoami'] });

    expect(whoami.status, whoami.stdout).toBe(0);
    expect(socketOf()).toBe(socket);
    expect(crewTokenOf(scout.shipId)).not.toBe(first);
  });
});

/**
 * Sessions as a map, as standInSessions, whose turns run the aeolus plugin's
 * own hooks as Claude Code runs them in the session's folder: its first
 * prompt and each line typed into an idle session start a turn
 * (UserPromptSubmit), and the test ends the turn (Stop), makes a tool call
 * (PreToolUse) or lets the session die. A line typed while the turn is busy
 * lands mid-turn, where no prompt hook runs (2a). Escape stops a busy turn
 * and runs no hook, as in Claude Code (decision 0040).
 */
function hookedSessions() {
  const sessions = new Map<ShipId, { status: ObservedSession['status']; folder: string; isBusy: boolean }>();
  /** Each line typed into a session, and what the hooks put into the turn it started, if any. */
  const turns: { typed: string; context: string }[] = [];
  /** Each session whose turn was stopped, in order. */
  const interrupts: ShipId[] = [];

  async function hook(folder: string, run: { script: string; payload: Record<string, unknown> }): Promise<string> {
    const { script, payload } = run;
    const hooked = await runCommand('bash', {
      args: [`${PLUGIN_ROOT}/scripts/${script}`],
      env: { HOME: home, CLAUDE_PROJECT_DIR: folder, CLAUDE_PLUGIN_DATA: pluginData, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, AEOLUS_FOLDER: folder, AEOLUS_DATA: pluginData, AEOLUS_CREWS: join(home, '.aeolus', 'crews', 'claude-code') },
      input: JSON.stringify({ session_id: 'c5858406-be86-46cd-8591-f4fb39b1fa61', cwd: folder, ...payload }),
    });
    expect(hooked.status, hooked.stderr).toBe(0);
    return hooked.stdout;
  }

  async function prompt(shipId: ShipId, text: string): Promise<void> {
    const session = sessions.get(shipId);
    if (session === undefined || session.status === 'exited' || session.isBusy) {
      return;
    }
    session.isBusy = true;
    turns.push({ typed: text, context: await hook(session.folder, { script: 'aeolus-turn.sh', payload: { hook_event_name: 'UserPromptSubmit', prompt: text } }) });
  }

  const folderOf = (shipId: ShipId) => sessions.get(shipId)?.folder ?? '';
  const runtime: SessionRuntime = {
    list: () => Promise.resolve([...sessions].map(([shipId, { status }]) => ({ shipId, status }))),
    stop: (shipId) => {
      sessions.delete(shipId);
      return Promise.resolve();
    },
    start: async ({ shipId, folder, command, env = {} }) => {
      sessions.set(shipId, { status: 'running', folder, isBusy: false });
      await launchHooks({ folder, env }, [{ hook_event_name: 'SessionStart', source: 'startup' }]);
      await prompt(shipId, command.at(-1) ?? '');
      await launchHooks({ folder, env }, [{ hook_event_name: 'PreToolUse', tool_name: 'Bash' }]);
    },
    type: async ({ shipId, text }) => {
      await prompt(shipId, text);
    },
    interrupt: (shipId) => {
      interrupts.push(shipId);
      const session = sessions.get(shipId);
      if (session !== undefined) {
        session.isBusy = false;
      }
      return Promise.resolve();
    },
    screen: () => Promise.resolve('❯ \n'),
  };

  return {
    runtime,
    turns,
    interrupts,
    /** The turn ends by itself: the Stop hook lets it end. */
    turnEnds: async (shipId: ShipId) => {
      const session = sessions.get(shipId);
      await hook(folderOf(shipId), { script: 'aeolus-stop.sh', payload: { hook_event_name: 'Stop', stop_hook_active: false } });
      if (session !== undefined) {
        session.isBusy = false;
      }
    },
    /** The session starts a turn of its own, as when a background task of its own ends. */
    turnStartsByItself: (shipId: ShipId) => {
      const session = sessions.get(shipId);
      if (session !== undefined) {
        session.isBusy = true;
      }
    },
    /** The first tool call of the turn: what the PreToolUse hook answered. */
    toolCall: (shipId: ShipId) => hook(folderOf(shipId), { script: 'aeolus-handover.sh', payload: { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/tmp/x' } } }),
    dies: (shipId: ShipId) => {
      const session = sessions.get(shipId);
      if (session !== undefined) {
        session.status = 'exited';
      }
    },
    /** The machine restarts: every session is gone. */
    reboots: () => {
      sessions.clear();
    },
  };
}

describe('the trierarch hands messages over on a real fleet (#756): the plugin keeps the store, the hooks confirm', () => {
  /** How long a session that died first waits before it starts again. */
  const RESTART_WAIT_MS = RESTART_DELAYS_MS[0];
  const MESSAGE = 'Review PR 12 and say what you found';

  /** A clock the test moves on, so a session that died starts again after its wait. */
  function aClock() {
    let offsetMs = 0;
    return { now: () => new Date(Date.now() + offsetMs), advance: (ms: number) => (offsetMs += ms) };
  }

  /** A trierarch that crewed scout, whose first turn ended: the session is idle. */
  async function aCrewedScout() {
    const sessions = hookedSessions();
    const clock = aClock();
    const trierarch = await aTrierarchOnTheFleet(undefined, { sessions: sessions.runtime, clock });
    const { useCases, argo, trierarchShip, scout, pass } = trierarch;
    unwrap(await useCases.requestCrew(argo, { shipId: scout.shipId, settings: { harness: 'claude-code', workspace: { kind: 'worktree', repository: 'aeolus-fleet' }, options: {} } }));
    unwrap(await useCases.assignCrew(argo, { shipId: scout.shipId, trierarchShipId: trierarchShip.shipId }));
    await pass();
    await pass();
    await sessions.turnEnds(scout.shipId);
    const send = async () => unwrap(await useCases.sendMessage(argo, { selector: { kind: 'ship', name: 'scout' }, payload: MESSAGE, idempotencyKey: newKey() })).messageId;
    return { ...trierarch, sessions, clock, send };
  }

  /** The delivery's events in order: their type, with the hand-over number and once more of a hand-over. */
  async function eventsOf(messageId: string) {
    const events = await database.event.findMany({ where: { messageId, type: { startsWith: 'Delivery' } }, orderBy: { seq: 'asc' }, select: { type: true, details: true } });
    return events.map(({ type, details }) => {
      const handed = z.object({ handOverNumber: z.number().optional(), onceMore: z.boolean().optional() }).parse(details);
      return type === 'DeliveryHanded' ? `${type} ${String(handed.handOverNumber)}${handed.onceMore === true ? ' once more' : ''}` : type;
    });
  }

  const deliveryOf = (messageId: string) => database.delivery.findFirstOrThrow({ where: { messageId }, select: { state: true, attempts: true } });

  it('hands a message to an idle session: received, handed, acknowledged by the prompt the line starts, handled when the turn ends (2a)', async () => {
    const { scout, pass, sessions, send } = await aCrewedScout();
    const messageId = await send();

    await pass();
    await sessions.turnEnds(scout.shipId);

    expect(sessions.turns.at(-1)?.typed).toBe(`Aeolus handed a message for scout to this session: it comes into this turn through the plugin's hooks, acknowledged. Do not receive or ack it. ${NO_TERMINAL_QUESTIONS}`);
    expect(sessions.turns.at(-1)?.context).toContain(MESSAGE);
    await expect(eventsOf(messageId)).resolves.toEqual(['DeliveryReceived', 'DeliveryHanded 1', 'DeliveryAcknowledged', 'DeliveryHandled']);
    await expect(deliveryOf(messageId)).resolves.toEqual({ state: 'handled', attempts: 1 });
  });

  it('makes the lease pushed and reports the turn busy and idle (D1)', async () => {
    const { scout, pass, sessions, send } = await aCrewedScout();
    await send();

    await pass();
    await sessions.turnEnds(scout.shipId);

    const lease = await database.lease.findFirstOrThrow({ where: { shipId: scout.shipId, endedAt: null }, select: { pushedAt: true } });
    expect(lease.pushedAt).toBeInstanceOf(Date);
    const turns = await database.event.findMany({ where: { shipId: scout.shipId, type: 'TurnReported' }, orderBy: { seq: 'asc' }, select: { details: true } });
    expect(turns.map(({ details }) => z.object({ turn: z.string() }).parse(details).turn)).toEqual(['busy', 'idle']);
  });

  it('hands nothing more while the session is busy with a message, then the next one once it is idle again', async () => {
    const { scout, pass, sessions, send } = await aCrewedScout();
    const first = await send();
    const second = await send();

    await pass();
    await pass();
    expect(await eventsOf(second)).toEqual([]);
    await sessions.turnEnds(scout.shipId);
    await pass();
    await sessions.turnEnds(scout.shipId);

    await expect(eventsOf(first)).resolves.toEqual(['DeliveryReceived', 'DeliveryHanded 1', 'DeliveryAcknowledged', 'DeliveryHandled']);
    await expect(eventsOf(second)).resolves.toEqual(['DeliveryReceived', 'DeliveryHanded 1', 'DeliveryAcknowledged', 'DeliveryHandled']);
  });

  it("a forced message arriving mid-turn stops the turn and comes in as a new prompt, and the stopped turn's message is handled when the forced turn ends (decision 0040)", async () => {
    const { scout, pass, sessions, send, useCases, argo } = await aCrewedScout();
    const plain = await send();
    await pass();
    const forced = unwrap(await useCases.sendMessage(argo, { selector: { kind: 'ship', name: 'scout' }, payload: 'Stop: the release is cancelled', idempotencyKey: newKey(), isForced: true })).messageId;

    await pass();
    await pass();
    await sessions.turnEnds(scout.shipId);

    expect(sessions.interrupts).toEqual([scout.shipId]);
    expect(sessions.turns.at(-1)?.context).toContain('Stop: the release is cancelled');
    await expect(eventsOf(plain)).resolves.toEqual(['DeliveryReceived', 'DeliveryHanded 1', 'DeliveryAcknowledged', 'DeliveryHandled']);
    await expect(eventsOf(forced)).resolves.toEqual(['DeliveryReceived', 'DeliveryHanded 1', 'DeliveryAcknowledged', 'DeliveryHandled']);
  });

  it('a forced message to an idle session goes first, before an older one, and stops no turn (decision 0040)', async () => {
    const { pass, sessions, send, useCases, argo } = await aCrewedScout();
    const older = await send();
    const forced = unwrap(await useCases.sendMessage(argo, { selector: { kind: 'ship', name: 'scout' }, payload: 'Stop: the release is cancelled', idempotencyKey: newKey(), isForced: true })).messageId;

    await pass();

    expect(sessions.interrupts).toEqual([]);
    expect(sessions.turns.at(-1)?.context).toContain('Stop: the release is cancelled');
    await expect(eventsOf(forced)).resolves.toEqual(['DeliveryReceived', 'DeliveryHanded 1', 'DeliveryAcknowledged']);
    await expect(eventsOf(older)).resolves.toEqual([]);
  });

  it('a line that lands mid-turn is confirmed by the first tool call (2a race)', async () => {
    const { scout, pass, sessions, send } = await aCrewedScout();
    const messageId = await send();
    sessions.turnStartsByItself(scout.shipId);

    await pass();
    const denied = await sessions.toolCall(scout.shipId);

    expect(denied).toContain(MESSAGE);
    await expect(eventsOf(messageId)).resolves.toEqual(['DeliveryReceived', 'DeliveryHanded 1', 'DeliveryAcknowledged']);
  });

  it('loses nothing when the trierarch restarts after a hand-over: the hooks confirm without it, and it hands nothing again (3.3)', async () => {
    const { scout, pass, aRunPass, sessions, send } = await aCrewedScout();
    const messageId = await send();
    sessions.turnStartsByItself(scout.shipId);
    await pass();

    const restarted = aRunPass();
    await sessions.toolCall(scout.shipId);
    await sessions.turnEnds(scout.shipId);
    await restarted();
    await sessions.turnEnds(scout.shipId);

    await expect(eventsOf(messageId)).resolves.toEqual(['DeliveryReceived', 'DeliveryHanded 1', 'DeliveryAcknowledged', 'DeliveryHandled']);
  });

  it('hands a message again with the next number when its session died before it took it, and the session started again confirms it (3.6)', async () => {
    const { scout, pass, sessions, clock, send } = await aCrewedScout();
    const messageId = await send();
    sessions.turnStartsByItself(scout.shipId);
    await pass();

    sessions.dies(scout.shipId);
    await pass();
    clock.advance(RESTART_WAIT_MS);
    await pass();
    await sessions.turnEnds(scout.shipId);

    await expect(eventsOf(messageId)).resolves.toEqual(['DeliveryReceived', 'DeliveryHanded 1', 'DeliveryHanded 2', 'DeliveryAcknowledged', 'DeliveryHandled']);
    await expect(deliveryOf(messageId)).resolves.toEqual({ state: 'handled', attempts: 2 });
  });

  it('hands a message once more when its session died after it took it, and ends it handled when that turn ends (3.7)', async () => {
    const { scout, pass, sessions, clock, send } = await aCrewedScout();
    const messageId = await send();
    await pass();

    sessions.dies(scout.shipId);
    await pass();
    clock.advance(RESTART_WAIT_MS);
    await pass();
    await sessions.turnEnds(scout.shipId);

    expect(sessions.turns.at(-1)?.context).toContain('aeolus: handed before');
    await expect(eventsOf(messageId)).resolves.toEqual(['DeliveryReceived', 'DeliveryHanded 1', 'DeliveryAcknowledged', 'DeliveryHanded 2 once more', 'DeliveryHandled']);
  });

  it('reports a message not handled when the session it was handed once more to died too (3.7)', async () => {
    const { scout, pass, sessions, clock, send } = await aCrewedScout();
    const messageId = await send();
    await pass();
    for (let death = 0; death < 2; death += 1) {
      sessions.dies(scout.shipId);
      await pass();
      clock.advance(10 * RESTART_WAIT_MS);
      await pass();
    }

    await expect(eventsOf(messageId)).resolves.toEqual(['DeliveryReceived', 'DeliveryHanded 1', 'DeliveryAcknowledged', 'DeliveryHanded 2 once more', 'DeliveryNotHandled']);
    await expect(deliveryOf(messageId)).resolves.toMatchObject({ state: 'notHandled' });
  });

  it('after the machine restarted, hands what the store holds by its state: a message never taken is handed again, then confirmed (3.10)', async () => {
    const { scout, pass, aRunPass, sessions, send } = await aCrewedScout();
    const messageId = await send();
    sessions.turnStartsByItself(scout.shipId);
    await pass();

    sessions.reboots();
    await aRunPass()();
    await sessions.turnEnds(scout.shipId);

    await expect(eventsOf(messageId)).resolves.toEqual(['DeliveryReceived', 'DeliveryHanded 1', 'DeliveryHanded 2', 'DeliveryAcknowledged', 'DeliveryHandled']);
  });
});
