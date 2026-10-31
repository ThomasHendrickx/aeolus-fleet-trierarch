import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineLabelOutputSchema, type ShipId } from '@aeolus-fleet/common';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';

import { createApp, createMigratedDatabase, createPrismaClient, createUseCases, FLEET_URL, newKey, OPERATOR, operatorCaller, secretOf, unwrap, type PrismaClient } from '@aeolus-fleet/core/testing';

import { createClaudeCodeHarness } from '../src/adapters/claude-code.js';
import { adapterFlagsOf, riskyFlagsOf } from '../src/adapters/harnesses.js';
import { createClaudeCodeSetup } from '../src/adapters/claude-code-setup.js';
import { readCrewFile } from '../src/adapters/files.js';
import { runCommand } from '../src/adapters/run-command.js';
import { createGitCheckouts } from '../src/adapters/git-checkouts.js';
import { createGitWorkspace } from '../src/adapters/git-workspace.js';
import { createJsonState } from '../src/adapters/json-state.js';
import { trierarchPaths, type TrierarchPaths } from '../src/adapters/paths.js';
import { createKeyStates } from '../src/adapters/key-states.js';
import { createModelLogins } from '../src/adapters/model-logins.js';
import { keyStatesFileOf } from '../src/adapters/proxy-runtime.js';
import { createRestFleet } from '../src/adapters/rest-fleet.js';
import { createTrust } from '../src/adapters/trust.js';
import { initTrierarch } from '../src/cli/init.js';
import type { ObservedSession, SessionRuntime } from '../src/core/ports.js';
import { RESTART_DELAYS_MS } from '../src/core/restart-policy.js';
import { createCallerCheck, type SessionRoots } from '../src/adapters/caller-check.js';
import { createHoldRuntime } from '../src/adapters/hold-runtime.js';
import { runningVersion } from '../src/adapters/version.js';
import { FAKE_CLAUDE_CODE, TRIERARCH_PROGRAM } from './support/hold-program.js';
import { createShipSockets, type ShipSockets } from '../src/adapters/ship-sockets.js';
import { createRunPass } from '../src/core/run-pass.js';
import { createHandleDelivery } from '../src/core/handle-delivery.js';
import { createReportSelf } from '../src/core/report-self.js';
import { TRUSTED_REPOSITORIES_CONTENT_TYPE } from '../src/core/trusted-repositories.js';
import { createTrustedRepositoriesFile, trustedClonesOf, withTrustedRepositories } from '../src/adapters/trusted-repositories-file.js';
import { CONFIGURATION } from './support/in-memory.js';
import { NO_TERMINAL_QUESTIONS } from '@aeolus-fleet/common';

// The trierarch against a real fleet server on Postgres, over REST: a crew
// request assigned to it is crewed in a worktree of a real git repository,
// with the folder's identity written through the aeolus-fleet plugin's own script,
// and removing the request ends the lease. Only the sessions are stand-ins:
// no Claude Code runs here, but its stand-in shows its first-run screens, as
// captured from Claude Code itself, until its own files say they are answered,
// and past them runs the aeolus-fleet plugin's own launch hook as its first prompt
// would: the session starts and makes a tool call (#490).

const PLUGIN_ROOT = fileURLToPath(new URL('../../../plugins/aeolus-fleet', import.meta.url));
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
/** Stops the holds a test started, before its home is removed. */
let stopHolds: () => Promise<void> = () => Promise.resolve();

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
  return claudeCodeStopsAt(command) ?? '❯ /aeolus-fleet:wake\n\n  Ran 1 shell command\n';
}

/** Runs the aeolus-fleet plugin's launch hook for each event, as Claude Code does in the session started in the folder with the launch id given. */
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

/** The stream-json event of a tool call, as Claude Code writes it: the activity the trierarch reads. */
const A_TOOL_CALL = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } });

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
    send: () => Promise.resolve(),
    interrupt: () => Promise.resolve(),
    lastEventAt: (shipId) => Promise.resolve(sessions.has(shipId) ? new Date() : undefined),
    events: (shipId) => Promise.resolve(sessions.has(shipId) ? [...claudeCodeShows(commands.get(shipId) ?? []).split('\n'), A_TOOL_CALL] : []),
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
  await stopHolds();
  stopHolds = () => Promise.resolve();
  await openSockets?.closeAll();
  openSockets = undefined;
  await server.close();
  await database.$disconnect();
  rmSync(home, { recursive: true, force: true });
});

/** A trierarch set up with init on a real fleet, with a ship scout of the fleet to crew, and one pass of its loop; Claude Code with the flags given. */
async function aTrierarchOnTheFleet(
  claudeCodeFlags: readonly string[] = CONFIGURATION.harnesses['claude-code']?.flags ?? [],
  at: { sessions?: SessionRuntime & Partial<SessionRoots>; clock?: { now: () => Date }; claudeCodeProgram?: string } = {},
) {
  const useCases = createUseCases({ prisma: database });
  const argo = operatorCaller(unwrap(await useCases.initialiseFleet({ name: 'home fleet', ...OPERATOR })));
  const trierarchShip = unwrap(await useCases.commissionShip(argo, { idempotencyKey: newKey(), name: 'mac-mini', type: 'trierarch', scopes: ['crew:run'] }));
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
    codex: { trust: () => Promise.reject(new Error('no Codex here')), trustAeolusHooks: () => Promise.reject(new Error('no Codex here')), loginKind: () => Promise.reject(new Error('no Codex here')) },
    isCodexInstalled: false,
    isClaudeCodeInstalled: true,
    nodeVersion: process.versions.node,
    service,
    running: () => Promise.resolve(undefined),
    detect: () => Promise.resolve({}),
  });
  const fleet = createRestFleet(await readCrewFile(paths.crewToken));
  const sessions: SessionRuntime & Partial<SessionRoots> = at.sessions ?? standInSessions();
  const harness = createClaudeCodeHarness({
    configuration,
    plugin: { root: () => Promise.resolve(PLUGIN_ROOT), data: pluginData, crews: join(home, '.aeolus', 'crews', 'claude-code') },
    projects: join(home, '.claude', 'projects'),
    sessions,
    setup: createClaudeCodeSetup({ homeDirectory: home, managedSettings: join(home, 'managed') }),
    permissionModes: () => undefined,
    ...(at.claudeCodeProgram !== undefined && { command: at.claudeCodeProgram }),
  });
  const workspace = createGitWorkspace({ configuration, root: paths.worktrees });
  const state = createJsonState(paths.state);
  const clock = at.clock ?? { now: () => new Date() };
  const logger = { warn: () => undefined, action: () => undefined };
  const setup = { configuration, configured: configuration, version: '0.0.0', adapterFlags: adapterFlagsOf(configuration), riskyFlags: riskyFlagsOf(configuration) };
  // The real caller check: the plugin's scripts run as children of this process, as aeolus-push.sh does of the trierarch, or of a session's hold.
  const mayCall = createCallerCheck({ platform: process.platform, sessionRootOf: (shipId) => sessions.sessionRootOf?.(shipId) ?? Promise.resolve(undefined) });
  const checkouts = createGitCheckouts({ configuration, root: paths.checkouts });
  const sockets = createShipSockets({ root: paths.sockets, fleetUrl: address, crewTokenOf: async (shipId) => (await state.load()).entries[shipId]?.crewToken, mayCall, log: () => undefined, refreshCheckouts: (shipId) => checkouts.refresh(shipId) });
  openSockets = sockets;
  // A new run pass over the same files is the trierarch started again.
  const aRunPass = () => createRunPass({ fleet, harnesses: { 'claude-code': harness }, processes: sessions, folderProcesses: { stopIn: () => Promise.resolve(0) }, workspace, trust: createTrust({ configuration, homeDirectory: home, env: {}, managedSettings: join(home, 'managed') }), state, setup, clock, logger, refuseModel: () => Promise.resolve(), newLaunchId: randomUUID, sockets, checkouts, modelLogins: { startProblem: () => Promise.resolve(undefined), keyState: () => Promise.resolve({ state: 'ready' }) }, sendReleasedUsage: () => Promise.resolve() });
  const pass = aRunPass();
  const leasesOf = (shipId: ShipId) => database.lease.count({ where: { shipId, endedAt: null } });
  const worktree = join(paths.worktrees, 'aeolus-fleet', 'scout');

  return { useCases, argo, trierarchShip, scout, pass, aRunPass, leasesOf, worktree, sockets, fleet, sessions, state, setup, clock };
}

describe('the trierarch on a real fleet', () => {
  it("reports each harness's login and each ship's, as core keeps the report, and never the key on the computer (api keys K7, K8)", async () => {
    const KEY = 'sk-ant-api03-integration-key-not-real';
    const { useCases, argo, trierarchShip, scout, pass, fleet, sessions, state, setup, clock } = await aTrierarchOnTheFleet();
    mkdirSync(paths.keys, { recursive: true, mode: 0o700 });
    writeFileSync(join(paths.keys, 'claude-code'), KEY, { mode: 0o600 });
    const modelLogins = createModelLogins({
      keyStates: createKeyStates({ keys: paths.keys, file: keyStatesFileOf(paths.proxy) }),
      claudeCode: { keyInReach: () => Promise.resolve(undefined) },
      codex: { loginKind: () => Promise.reject(new Error('no Codex here')) },
    });
    unwrap(await useCases.requestCrew(argo, { shipId: scout.shipId, settings: { harness: 'claude-code', workspace: { kind: 'worktree', repository: 'aeolus-fleet' }, options: {} } }));
    unwrap(await useCases.assignCrew(argo, { shipId: scout.shipId, trierarchShipId: trierarchShip.shipId }));
    await pass();
    await pass();
    // The configuration moved the harness to its key after scout started: its running session keeps its subscription (K3).
    const reportSelf = createReportSelf({ fleetKey: { isCutOff: () => false }, fleet, processes: sessions, trust: createTrust({ configuration: setup.configuration, homeDirectory: home, env: {}, managedSettings: join(home, 'managed') }), state, setup, readLoad: () => Promise.resolve(undefined), readUsage: () => Promise.resolve({ subscriptions: [], ships: [] }), clock, modelLogins, logins: { default: { 'claude-code': 'apiKey' } } });

    await reportSelf();

    const reported = unwrap(await useCases.getShip(argo, { shipId: trierarchShip.shipId }));
    expect(reported).toMatchObject({ report: { details: { harnesses: [{ harness: 'claude-code', login: { default: 'apiKey', key: 'ready' } }], logins: [{ shipId: scout.shipId, login: 'subscription', next: 'apiKey' }] } } });
    expect(JSON.stringify(reported)).not.toContain(KEY);
    expect(JSON.stringify(await database.event.findMany({ select: { details: true } }))).not.toContain(KEY);
  });

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
    await expect(database.lease.findFirstOrThrow({ where: { shipId: scout.shipId } })).resolves.toMatchObject({ activityIntervalSeconds: 30, activityKind: 'tool', activityTool: 'Bash' });

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

  it('registers a Codex session as codex, so the fleet keeps codex as its lease harness (aeolus-fleet#1408)', async () => {
    const { useCases, argo } = await aTrierarchOnTheFleet();
    const lookout = unwrap(await useCases.commissionShip(argo, { idempotencyKey: newKey(), name: 'lookout', type: 'reviewer' }));

    await createRestFleet({ fleetUrl: address, crewToken: '' }).register({ shipId: lookout.shipId, secret: secretOf(lookout.secret), harness: 'codex' });

    await expect(database.lease.findMany({ where: { shipId: lookout.shipId, endedAt: null }, select: { harness: true } })).resolves.toEqual([{ harness: 'codex' }]);
  });
});

describe("contained access on a real fleet (decision 0026): the session calls over its ship's socket, and only the trierarch holds the crew token", () => {
  const SETTINGS = { harness: 'claude-code', workspace: { kind: 'worktree', repository: 'aeolus-fleet' }, options: {} } as const;

  /** A fleet call of the session in the worktree, through the aeolus-fleet plugin's own script, as Claude Code's Bash tool makes it. */
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
 * Sessions as a map, as standInSessions, whose turns run the aeolus-fleet plugin's
 * own hooks as headless Claude Code runs them in the session's folder: each
 * user line sent to an idle session, its first prompt among them, starts a
 * turn (UserPromptSubmit), and the test ends the turn (Stop), makes a tool
 * call (PreToolUse) or lets the session die. A line sent while the turn is
 * busy lands mid-turn, where no prompt hook runs (2a). An interrupt stops a
 * busy turn and runs no hook, as in Claude Code (decision 0040).
 */
function hookedSessions() {
  const sessions = new Map<ShipId, { status: ObservedSession['status']; folder: string; isBusy: boolean }>();
  /** Each prompt sent to a session, and what the hooks put into the turn it started, if any. */
  const turns: { typed: string; context: string }[] = [];
  /** Each session whose turn was stopped, in order. */
  const interrupts: ShipId[] = [];
  /** The launch environment of each session whose first prompt has not come yet. */
  const launched = new Map<ShipId, Readonly<Record<string, string>>>();

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
    start: async ({ shipId, folder, env = {} }) => {
      sessions.set(shipId, { status: 'running', folder, isBusy: false });
      launched.set(shipId, env);
      await launchHooks({ folder, env }, [{ hook_event_name: 'SessionStart', source: 'startup' }]);
    },
    // A user message as headless Claude Code takes it on stdin; the first one's turn makes the launch's first tool call.
    send: async ({ shipId, line }) => {
      await prompt(shipId, z.object({ message: z.object({ content: z.string() }) }).parse(JSON.parse(line)).message.content);
      const env = launched.get(shipId);
      launched.delete(shipId);
      if (env !== undefined) {
        await launchHooks({ folder: folderOf(shipId), env }, [{ hook_event_name: 'PreToolUse', tool_name: 'Bash' }]);
      }
    },
    interrupt: (shipId) => {
      interrupts.push(shipId);
      const session = sessions.get(shipId);
      if (session !== undefined) {
        session.isBusy = false;
      }
      return Promise.resolve();
    },
    events: () => Promise.resolve([]),
    lastEventAt: () => Promise.resolve(undefined),
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

describe('every session restarted at once, each on a hold of its own (#881, headless H8 to H10)', () => {
  const SHIPS = ['scout', 'lookout', 'helmsman'] as const;
  /** How long a session that died first waits before it starts again. */
  const RESTART_WAIT_MS = RESTART_DELAYS_MS[0];

  /** The stand-in for headless Claude Code, running the aeolus-fleet plugin's own hooks in this test's home, as a program the adapter runs. */
  function aClaudeCodeProgram(): string {
    const program = join(home, 'claude');
    const crews = join(home, '.aeolus', 'crews', 'claude-code');
    writeFileSync(
      program,
      `#!/bin/sh\nexport HOME='${home}' AEOLUS_DATA='${pluginData}' AEOLUS_CREWS='${crews}'\nexec ${FAKE_CLAUDE_CODE.join(' ')} --plugin '${PLUGIN_ROOT}' '${pluginData}' "$@"\n`,
      { mode: 0o755 },
    );
    return program;
  }

  /** Each prompt the session of the ship took, and what the plugin's hooks added to its turn. */
  function turnsOf(ship: string): { prompt: string; context: string }[] {
    const turns = join(paths.worktrees, 'aeolus-fleet', ship, 'fake-turns.jsonl');
    return existsSync(turns)
      ? readFileSync(turns, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => z.object({ prompt: z.string(), context: z.string() }).parse(JSON.parse(line)))
      : [];
  }

  it('hands each session only its own ship\'s deliveries after the trierarch and every session it runs were started again', async () => {
    let offsetMs = 0;
    const clock = { now: () => new Date(Date.now() + offsetMs) };
    const sessions = createHoldRuntime({ sessions: paths.sessions, program: TRIERARCH_PROGRAM, version: runningVersion(), platform: process.platform });
    // Stopped before the test's home goes, which afterEach removes: a session would write into it.
    stopHolds = async () => {
      for (const session of await sessions.list()) {
        await sessions.stop(session.shipId);
      }
    };
    const { useCases, argo, trierarchShip, scout, pass, aRunPass } = await aTrierarchOnTheFleet(undefined, { sessions, clock, claudeCodeProgram: aClaudeCodeProgram() });
    const shipIds = [scout.shipId];
    for (const name of SHIPS.slice(1)) {
      shipIds.push(unwrap(await useCases.commissionShip(argo, { idempotencyKey: newKey(), name, type: 'reviewer' })).shipId);
    }
    for (const shipId of shipIds) {
      unwrap(await useCases.requestCrew(argo, { shipId, settings: { harness: 'claude-code', workspace: { kind: 'worktree', repository: 'aeolus-fleet' }, options: {} } }));
      unwrap(await useCases.assignCrew(argo, { shipId, trierarchShipId: trierarchShip.shipId }));
    }
    await pass();
    await pass();
    await expect(sessions.list()).resolves.toHaveLength(SHIPS.length);

    // Every session killed at once, and the trierarch started again (#880, #881).
    for (const shipId of shipIds) {
      process.kill((await sessions.sessionRootOf(shipId)) ?? 0, 'SIGKILL');
    }
    await expect.poll(async () => (await sessions.list()).map((session) => session.status)).toEqual(SHIPS.map(() => 'exited'));
    const restarted = aRunPass();
    await restarted();
    offsetMs += RESTART_WAIT_MS;
    await restarted();
    await expect(sessions.list()).resolves.toEqual(expect.arrayContaining(shipIds.map((shipId) => ({ shipId, status: 'running' }))));

    for (const name of SHIPS) {
      unwrap(await useCases.sendMessage(argo, { selector: { kind: 'ship', name }, payload: `Only for ${name}`, idempotencyKey: newKey() }));
    }
    // A pass hands each idle session one message: passes run until every message is handled, as the loop runs them.
    const states = async () => (await database.delivery.findMany({ where: { message: { payload: { startsWith: 'Only for' } } }, select: { state: true } })).map((delivery) => delivery.state);
    await expect
      .poll(async () => {
        await restarted();
        return states();
      }, { timeout: 60_000 })
      .toEqual(SHIPS.map(() => 'handled'));

    for (const name of SHIPS) {
      const contexts = turnsOf(name).map((turn) => turn.context).join('\n');
      expect(contexts, name).toContain(`Only for ${name}`);
      for (const other of SHIPS.filter((each) => each !== name)) {
        expect(contexts, `${name} took ${other}'s`).not.toContain(`Only for ${other}`);
      }
    }
  }, 120_000);
});

describe('the trusted repositories on a real fleet (aeolus-fleet#384)', () => {
  /** A ship call over REST with the crew token given, answering the fleet's JSON. */
  async function shipCall(path: string, call: { body: unknown; crewToken?: string }): Promise<unknown> {
    const { body, crewToken } = call;
    const response = await fetch(`${address}/api/v1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(crewToken !== undefined && { authorization: `Bearer ${crewToken}` }) },
      body: JSON.stringify(body),
    });
    const answer: unknown = await response.json();
    expect(response.ok, JSON.stringify(answer)).toBe(true);
    return answer;
  }

  /**
   * The trierarch plugin's ship as it runs (an agent ship here: core 0.28
   * commissions no plugin ship, and the trierarch goes by the ship id alone):
   * a ship that commissions the
   * machine's trierarch ship, labels both trierarch=*, and declares that
   * trierarch=* may send to trierarch=*, so its messages reach the machine.
   */
  async function aPluginWithAMachine() {
    const useCases = createUseCases({ prisma: database });
    const argo = operatorCaller(unwrap(await useCases.initialiseFleet({ name: 'home fleet', ...OPERATOR })));
    const plugin = unwrap(
      await useCases.commissionShip(argo, { idempotencyKey: newKey(), name: 'trierarch-plugin', type: 'trierarch-plugin', scopes: ['fleet:commission', 'crew:assign', 'crew:run', 'labels:define', 'labels:assign'] }),
    );
    const { crewToken } = z.object({ crewToken: z.string() }).parse(await shipCall('/ship/register', { body: { shipId: plugin.shipId, secret: secretOf(plugin.secret), location: { kind: 'SERVER' }, harness: 'aeolus-trierarch-plugin' } }));
    const machine = z
      .object({ shipId: z.templateLiteral(['shp_', z.string()]), secret: z.string() })
      .parse(await shipCall('/fleet/commission', { body: { name: 'mac-mini', type: 'trierarch', scopes: ['crew:run'], idempotencyKey: newKey() }, crewToken }));
    const label = defineLabelOutputSchema.parse(await shipCall('/fleet/defineLabel', { body: { key: 'trierarch', values: ['plugin', 'machine'] }, crewToken }));
    const valueOf = (value: string) => label.values.find((each) => each.value === value)?.id;
    await shipCall('/fleet/assignLabel', { body: { shipId: plugin.shipId, valueId: valueOf('plugin') }, crewToken });
    await shipCall('/fleet/assignLabel', { body: { shipId: machine.shipId, valueId: valueOf('machine') }, crewToken });
    const term = { labelId: label.labelId, value: '*' };
    await shipCall('/fleet/declareNetworkRules', { body: { rules: [{ verb: 'send', from: [term], to: [term] }] }, crewToken });
    const scout = unwrap(await useCases.commissionShip(argo, { idempotencyKey: newKey(), name: 'scout', type: 'reviewer' }));
    const sendTrusted = (repositories: readonly { name: string; url: string }[]) =>
      shipCall('/ship/send', { body: { selector: { kind: 'ship', shipId: machine.shipId }, contentType: TRUSTED_REPOSITORIES_CONTENT_TYPE, payload: JSON.stringify({ repositories }), idempotencyKey: newKey(), model: 'claude-opus-5-5' }, crewToken });
    return { useCases, argo, plugin, machine, scout, sendTrusted };
  }

  it('a machine that never had a trusted repository takes the list from the plugin\'s ship, offers it, clones it and crews a ship in it', async () => {
    const { useCases, argo, plugin, machine, scout, sendTrusted } = await aPluginWithAMachine();
    // The list names an https URL, as the trierarch plugin sends; in this test git reads it as a local remote, and may clone a file URL.
    const remote = join(home, 'remote', 'hemma.git');
    await git(['clone', '-q', '--bare', repository, remote]);
    const url = 'https://git.example.com/hemma.git';
    Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${remote}.insteadOf`, GIT_CONFIG_VALUE_0: url });
    onTestFinished(() => {
      delete process.env.GIT_CONFIG_COUNT;
      delete process.env.GIT_CONFIG_KEY_0;
      delete process.env.GIT_CONFIG_VALUE_0;
    });
    const configuration = { ...CONFIGURATION, harnesses: { 'claude-code': { options: {}, ...CONFIGURATION.harnesses['claude-code'], flags: [] } }, repositories: {}, folders: { notes: { path: join(home, 'notes') } } };
    mkdirSync(dirname(paths.config), { recursive: true });
    writeFileSync(paths.config, JSON.stringify(configuration));
    const quiet = { text: () => Promise.reject(new Error('asked')), secret: () => Promise.reject(new Error('asked')), confirm: () => Promise.reject(new Error('asked')), say: () => undefined, step: () => undefined };
    const claudeCode = createClaudeCodeSetup({ homeDirectory: home, managedSettings: join(home, 'managed') });
    await initTrierarch({
      homeDirectory: home,
      paths,
      flags: { fleetUrl: address, shipId: machine.shipId, pluginShipId: plugin.shipId, secret: machine.secret, isYes: true },
      prompter: quiet,
      fleetAt: (fleetUrl) => createRestFleet({ fleetUrl, crewToken: '' }),
      claudeCode,
      codex: { trust: () => Promise.reject(new Error('no Codex here')), trustAeolusHooks: () => Promise.reject(new Error('no Codex here')), loginKind: () => Promise.reject(new Error('no Codex here')) },
      isCodexInstalled: false,
      isClaudeCodeInstalled: true,
      nodeVersion: process.versions.node,
      service: { install: () => Promise.resolve(), rewrite: () => Promise.resolve(), restart: () => Promise.resolve(), status: () => Promise.resolve({ file: 'none', isInstalled: true, isRunning: true }) },
      running: () => Promise.resolve(undefined),
      detect: () => Promise.resolve({}),
    });
    const crew = await readCrewFile(paths.crewToken);
    const fleet = createRestFleet(crew);
    const logger = { warn: () => undefined, action: () => undefined };
    // As run composes them: the list kept beside the configuration, each clone trusted as the list arrives.
    const trustedRepositories = createTrustedRepositoriesFile({
      file: paths.trustedRepositories,
      clonesRoot: paths.repositories,
      trustClones: async (clones) => {
        for (const clone of clones) {
          await claudeCode.trust(clone);
        }
      },
    });
    await trustedRepositories.load();
    const offered = withTrustedRepositories(configuration, trustedRepositories);
    const handle = createHandleDelivery({ fleet, logger, trustedRepositories, ...(crew.pluginShipId !== undefined && { pluginShipId: crew.pluginShipId }) });
    const sessions = standInSessions();
    const harness = createClaudeCodeHarness({ configuration: offered, plugin: { root: () => Promise.resolve(PLUGIN_ROOT), data: pluginData, crews: join(home, '.aeolus', 'crews', 'claude-code') }, projects: join(home, '.claude', 'projects'), sessions, setup: claudeCode, permissionModes: () => undefined });
    const workspace = createGitWorkspace({ configuration: offered, root: paths.worktrees, clones: trustedClonesOf({ configured: configuration, held: trustedRepositories, root: paths.repositories, protocols: 'file' }) });
    const state = createJsonState(paths.state);
    const trust = createTrust({ configuration: offered, homeDirectory: home, env: {}, managedSettings: join(home, 'managed') });
    const setup = { configuration: offered, configured: configuration, version: '0.0.0', adapterFlags: adapterFlagsOf(configuration), riskyFlags: riskyFlagsOf(configuration) };
    const checkouts = createGitCheckouts({ configuration, root: paths.checkouts });
    const mayCall = createCallerCheck({ platform: process.platform, sessionRootOf: () => Promise.resolve(undefined) });
    const sockets = createShipSockets({ root: paths.sockets, fleetUrl: address, crewTokenOf: async (shipId) => (await state.load()).entries[shipId]?.crewToken, mayCall, log: () => undefined, refreshCheckouts: (shipId) => checkouts.refresh(shipId) });
    openSockets = sockets;
    const pass = createRunPass({ fleet, harnesses: { 'claude-code': harness }, processes: sessions, folderProcesses: { stopIn: () => Promise.resolve(0) }, workspace, trust, state, setup, clock: { now: () => new Date() }, logger, refuseModel: () => Promise.resolve(), newLaunchId: randomUUID, sockets, checkouts, modelLogins: { startProblem: () => Promise.resolve(undefined), keyState: () => Promise.resolve({ state: 'ready' }) }, sendReleasedUsage: () => Promise.resolve() });
    const reportSelf = createReportSelf({ fleetKey: { isCutOff: () => false }, fleet, processes: sessions, trust, state, setup, readLoad: () => Promise.resolve(undefined), readUsage: () => Promise.resolve({ subscriptions: [], ships: [] }), clock: { now: () => new Date() }, modelLogins: { keyState: () => Promise.resolve({ state: 'ready' }) } });

    await sendTrusted([{ name: 'hemma', url }]);
    for (const delivery of await fleet.receive()) {
      await handle(delivery);
    }
    await reportSelf();

    const reported = unwrap(await useCases.getShip(argo, { shipId: machine.shipId }));
    expect(reported).toMatchObject({ report: { details: { workspaces: { repositories: ['hemma'] } } } });
    unwrap(await useCases.requestCrew(argo, { shipId: scout.shipId, settings: { harness: 'claude-code', workspace: { kind: 'worktree', repository: 'hemma' }, options: {} } }));
    unwrap(await useCases.assignCrew(argo, { shipId: scout.shipId, trierarchShipId: machine.shipId }));
    await pass();
    await pass();

    await expect(database.crewRequest.findUniqueOrThrow({ where: { shipId: scout.shipId } })).resolves.toMatchObject({ status: 'running' });
    expect(existsSync(join(paths.repositories, 'hemma', '.git'))).toBe(true);
    expect(existsSync(join(paths.worktrees, 'hemma', 'scout', 'README.md'))).toBe(true);
  });
});
