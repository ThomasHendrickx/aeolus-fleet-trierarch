import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { trierarchConfigurationSchema, type ShipId, type TrierarchConfiguration } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClaudeCodeSetup } from '../adapters/claude-code-setup.js';
import type { CodexSetup } from '../adapters/codex-setup.js';
import { trierarchPaths, type TrierarchPaths } from '../adapters/paths.js';
import type { Service, ServiceStatus } from '../adapters/service.js';
import { newId } from '../../test/support/in-memory.js';
import { initTrierarch, type InitFlags } from './init.js';
import type { Prompter } from './prompter.js';
import type { Detected } from '../core/ports.js';

const SECRET = 'aeolus_sk_v1_trierarch-secret';
const FLEET_URL = 'https://fleet.example.com';

let home: string;
let paths: TrierarchPaths;
let registered: { fleetUrl: string; shipId: ShipId; secret: string }[];
let service: FakeService;
let repository: string;
let codex: FakeCodexSetup;
let isCodexInstalled: boolean;

/** A prompter that answers from a script, in order, each answer for a question containing its words; it fails on any question it was not given. */
class ScriptedPrompter implements Prompter {
  readonly asked: string[] = [];
  readonly hidden: string[] = [];
  readonly said: string[] = [];
  readonly steps: string[] = [];
  constructor(private readonly script: [string, string | boolean][]) {}

  private next(question: string): string | boolean {
    this.asked.push(question);
    const [words, answer] = this.script.shift() ?? ['', ''];
    if (words === '' || !question.includes(words)) {
      throw new Error(`Not scripted: "${question}" (expected one with "${words}")`);
    }
    return answer;
  }

  text(question: string): Promise<string> {
    return Promise.resolve(String(this.next(question)));
  }

  secret(question: string): Promise<string> {
    this.hidden.push(question);
    return Promise.resolve(String(this.next(question)));
  }

  confirm(question: string): Promise<boolean> {
    return Promise.resolve(this.next(question) === true);
  }

  say(message: string): void {
    this.said.push(message);
  }

  step(title: string): void {
    this.steps.push(title);
  }

  get isDone(): boolean {
    return this.script.length === 0;
  }
}

class FakeService implements Pick<Service, 'install' | 'restart' | 'status'> {
  isInstalled = false;
  restarts = 0;
  install(): Promise<void> {
    this.isInstalled = true;
    return Promise.resolve();
  }
  restart(): Promise<void> {
    this.restarts += 1;
    return Promise.resolve();
  }
  status(): Promise<ServiceStatus> {
    return Promise.resolve({ file: '/LaunchAgents/dev.aeolus-fleet.trierarch.plist', isInstalled: this.isInstalled, isRunning: this.isInstalled });
  }
}

/** Codex's own configuration as its app server keeps it: the folders it trusts and the hooks, by key. */
class FakeCodexSetup implements CodexSetup {
  readonly trusted: string[] = [];
  readonly hooks = new Map<string, 'trusted' | 'untrusted'>([
    ['aeolus@aeolus-fleet:hooks/hooks.json:stop:0:0', 'untrusted'],
    ['aeolus@aeolus-fleet:hooks/hooks.json:user_prompt_submit:0:0', 'untrusted'],
  ]);
  isMissing = false;

  trust(folders: readonly string[]): Promise<void> {
    if (this.isMissing) {
      return Promise.reject(new Error('Codex is not installed: codex was not found'));
    }
    this.trusted.push(...folders);
    return Promise.resolve();
  }

  trustAeolusHooks(): Promise<readonly string[]> {
    const keys = [...this.hooks].filter(([, status]) => status === 'untrusted').map(([key]) => key);
    for (const key of keys) {
      this.hooks.set(key, 'trusted');
    }
    return Promise.resolve(keys);
  }
}

/** What init's detection finds, and each time it was asked. */
let detected: Detected;
let detections: { harnesses: readonly string[]; isForced: boolean }[];

beforeEach(() => {
  detected = {};
  detections = [];
  codex = new FakeCodexSetup();
  isCodexInstalled = false;
  home = mkdtempSync(join(tmpdir(), 'trierarch-init-'));
  paths = trierarchPaths({ homeDirectory: home });
  registered = [];
  service = new FakeService();
  repository = join(home, 'Projects', 'aeolus-fleet');
  mkdirSync(join(repository, '.git'), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function init(flags: Partial<InitFlags>, prompter: Prompter = new ScriptedPrompter([])) {
  return initTrierarch({
    isCodexInstalled,
    codex,
    homeDirectory: home,
    paths,
    flags: { isYes: false, ...flags },
    prompter,
    fleetAt: (fleetUrl) => ({
      registerSelf: (crew) => {
        registered.push({ fleetUrl, ...crew });
        return Promise.resolve({ crewToken: 'aeolus_ct_v1_trierarch' });
      },
    }),
    claudeCode: createClaudeCodeSetup({ homeDirectory: home }),
    service,
    detect: (at) => {
      detections.push(at);
      return Promise.resolve(detected);
    },
  });
}

function configuration(): TrierarchConfiguration {
  return trierarchConfigurationSchema.parse(JSON.parse(readFileSync(paths.config, 'utf8')));
}

/** The script for a machine set up with every default: no flags, no repository, the caps as they are, the service installed. */
function defaults(): [string, string | boolean][] {
  return [
    ['--dangerously-skip-permissions', false],
    ['--remote-control', false],
    ['repository', ''],
    ['folder', ''],
    ['ships', '4'],
    ['sessions', '2'],
    ['Install the service', true],
  ];
}

/** The defaults, but with sessions that skip permissions, and the answer to accepting bypass permissions mode. */
function skippingPermissions(isAccepting: boolean): [string, string | boolean][] {
  const [, ...rest] = defaults();
  const install = rest.pop() ?? ['Install the service', true];
  return [['--dangerously-skip-permissions', true], ...rest, ['bypass permissions', isAccepting], install];
}

describe('aeolus-trierarch init, the whole setup', () => {
  it("asks for what is missing, the secret hidden, registers the trierarch's own ship and keeps its crew token with its ship id, readable by its user only", async () => {
    const shipId = newId('ship');
    const prompter = new ScriptedPrompter([['Fleet URL', `${FLEET_URL}/`], ['ship id', shipId], ['secret', SECRET], ...defaults()]);

    await init({}, prompter);

    expect(registered).toEqual([{ fleetUrl: FLEET_URL, shipId, secret: SECRET }]);
    expect(prompter.hidden).toEqual([expect.stringContaining('secret')]);
    expect(readFileSync(paths.crewToken, 'utf8')).toBe(`fleetUrl=${FLEET_URL}\nshipId=${shipId}\ncrewToken=aeolus_ct_v1_trierarch\n`);
    expect(statSync(paths.crewToken).mode & 0o777).toBe(0o600);
    expect(prompter.isDone).toBe(true);
  });

  it('asks again for a ship id that is none', async () => {
    const shipId = newId('ship');
    const prompter = new ScriptedPrompter([['Fleet URL', FLEET_URL], ['ship id', 'trierarch-mac'], ['ship id', shipId], ['secret', SECRET], ...defaults()]);

    await init({}, prompter);

    expect(registered.map((crew) => crew.shipId)).toEqual([shipId]);
    expect(prompter.said).toContain('trierarch-mac is no ship id: it starts with shp_.');
  });

  it('asks nothing with --yes and every flag, writing a configuration with no flag and no repository, and installing the service', async () => {
    const shipId = newId('ship');

    const report = await init({ fleetUrl: FLEET_URL, shipId, secret: SECRET, isYes: true });

    expect(registered).toEqual([{ fleetUrl: FLEET_URL, shipId, secret: SECRET }]);
    expect(configuration()).toEqual({ $schema: './config.schema.json', caps: { ships: 4, running: 2 }, repositories: {}, folders: {}, harnesses: { 'claude-code': { flags: [], options: {} } } });
    expect(existsSync(paths.configSchema)).toBe(true);
    expect(service.isInstalled).toBe(true);
    expect(report).toMatchObject({ isSetUpAlready: false, configuration: 'written', service: 'installed' });
  });

  it('refuses with --yes when a flag is missing, naming it, and registers nothing', async () => {
    await expect(init({ fleetUrl: FLEET_URL, isYes: true })).rejects.toThrow('init --yes needs --fleet-url, --ship-id and --secret: --ship-id and --secret are missing');
    expect(registered).toEqual([]);
  });

  it('refuses a --ship-id that is no ship id', async () => {
    await expect(init({ fleetUrl: FLEET_URL, shipId: 'trierarch-mac', secret: SECRET, isYes: true })).rejects.toThrow('trierarch-mac is no ship id: it starts with shp_.');
  });

  it('goes through its questions in steps: the fleet, Claude Code, Codex, workspaces, caps and the service', async () => {
    const prompter = new ScriptedPrompter(defaults());

    await init({ fleetUrl: FLEET_URL, shipId: newId('ship'), secret: SECRET }, prompter);

    expect(prompter.steps).toEqual(['The fleet', 'Claude Code', 'Codex', 'Workspaces', 'Caps', 'The service']);
  });

  it('sets the Claude Code flags as answered, the repositories it may make worktrees of, and the caps', async () => {
    const prompter = new ScriptedPrompter([
      ['--dangerously-skip-permissions', true],
      ['--remote-control', true],
      ['repository', 'aeolus-fleet'],
      ['aeolus-fleet', '~/Projects/aeolus-fleet'],
      ['repository', ''],
      ['folder', ''],
      ['ships', '6'],
      ['sessions', '3'],
      ['bypass permissions', true],
      ['Install the service', false],
    ]);

    await init({ fleetUrl: FLEET_URL, shipId: newId('ship'), secret: SECRET }, prompter);

    expect(configuration()).toMatchObject({
      caps: { ships: 6, running: 3 },
      repositories: { 'aeolus-fleet': { path: repository } },
      harnesses: { 'claude-code': { flags: ['--dangerously-skip-permissions', '--remote-control'], options: {} } },
    });
    expect(prompter.isDone).toBe(true);
  });

  it('asks again for a repository that is no git checkout, and for a cap that is no positive whole number', async () => {
    const prompter = new ScriptedPrompter([
      ['--dangerously-skip-permissions', false],
      ['--remote-control', false],
      ['repository', 'notes'],
      ['notes', join(home, 'notes')],
      ['notes', repository],
      ['repository', ''],
      ['folder', ''],
      ['ships', '0'],
      ['ships', 'many'],
      ['ships', '5'],
      ['sessions', '2'],
      ['Install the service', false],
    ]);

    await init({ fleetUrl: FLEET_URL, shipId: newId('ship'), secret: SECRET }, prompter);

    expect(configuration()).toMatchObject({ caps: { ships: 5, running: 2 }, repositories: { notes: { path: repository } } });
    expect(prompter.said).toContain(`${join(home, 'notes')} is no git checkout.`);
    expect(prompter.said).toContain('A cap is a whole number of 1 or more.');
  });

  it('trusts the worktree root for Claude Code, so a session in any worktree starts with no trust question', async () => {
    const report = await init({ fleetUrl: FLEET_URL, shipId: newId('ship'), secret: SECRET, isYes: true });

    await expect(createClaudeCodeSetup({ homeDirectory: home }).isTrusted(paths.worktrees)).resolves.toBe(true);
    expect(existsSync(paths.worktrees)).toBe(true);
    expect(report.trusted).toEqual([paths.worktrees]);
  });

  it('accepts bypass permissions mode for the user when the sessions skip permissions and the operator agrees', async () => {
    const prompter = new ScriptedPrompter(skippingPermissions(true));

    const report = await init({ fleetUrl: FLEET_URL, shipId: newId('ship'), secret: SECRET }, prompter);

    await expect(createClaudeCodeSetup({ homeDirectory: home }).isSkipPermissionsAccepted()).resolves.toBe(true);
    expect(report.isSkipPermissionsAccepted).toBe(true);
  });

  it('leaves bypass permissions mode alone when the operator declines, saying a session would wait on the question', async () => {
    const prompter = new ScriptedPrompter(skippingPermissions(false));

    const report = await init({ fleetUrl: FLEET_URL, shipId: newId('ship'), secret: SECRET }, prompter);

    await expect(createClaudeCodeSetup({ homeDirectory: home }).isSkipPermissionsAccepted()).resolves.toBe(false);
    expect(report.isSkipPermissionsAccepted).toBe(false);
    expect(report.said.join('\n')).toContain('waits on that question');
  });

  it('asks nothing about bypass permissions mode when the sessions do not skip permissions', async () => {
    const prompter = new ScriptedPrompter(defaults());

    await init({ fleetUrl: FLEET_URL, shipId: newId('ship'), secret: SECRET }, prompter);

    expect(prompter.asked.join('\n')).not.toContain('bypass permissions');
  });

  it('says how to install the service later when the operator declines it now', async () => {
    const prompter = new ScriptedPrompter([...defaults().slice(0, -1), ['Install the service', false]]);

    const report = await init({ fleetUrl: FLEET_URL, shipId: newId('ship'), secret: SECRET }, prompter);

    expect(service.isInstalled).toBe(false);
    expect(report.service).toBe('notInstalled');
    expect(report.said.join('\n')).toContain('aeolus-trierarch install');
  });

  it('never writes the secret', async () => {
    await init({ fleetUrl: FLEET_URL, shipId: newId('ship'), secret: SECRET, isYes: true });

    for (const file of readdirSync(paths.home, { recursive: true, withFileTypes: true })) {
      if (file.isFile()) {
        expect(readFileSync(join(file.parentPath, file.name), 'utf8')).not.toContain(SECRET);
      }
    }
  });
});

describe('aeolus-trierarch init on a machine set up already', () => {
  let shipId: ShipId;

  beforeEach(async () => {
    shipId = newId('ship');
    await init({ fleetUrl: FLEET_URL, shipId, secret: SECRET, isYes: true });
    registered = [];
  });

  it('says so and never registers again, keeping the configuration when the operator does not change it', async () => {
    const before = readFileSync(paths.config, 'utf8');
    const prompter = new ScriptedPrompter([['Change the configuration', false]]);

    const report = await init({}, prompter);

    expect(registered).toEqual([]);
    expect(readFileSync(paths.config, 'utf8')).toBe(before);
    expect(report).toMatchObject({ isSetUpAlready: true, configuration: 'kept', service: 'unchanged' });
    expect(report.said[0]).toBe(`This machine is set up already: the trierarch crews ${shipId} at ${FLEET_URL}.`);
  });

  it('changes the configuration from what it holds, then offers to restart the trierarch so it reads it', async () => {
    const prompter = new ScriptedPrompter([
      ['Change the configuration', true],
      ['--dangerously-skip-permissions', false],
      ['--remote-control', true],
      ['repository', 'aeolus-fleet'],
      ['aeolus-fleet', repository],
      ['repository', ''],
      ['folder', ''],
      ['ships', '4'],
      ['sessions', '2'],
      ['Restart', true],
    ]);

    const report = await init({}, prompter);

    expect(configuration().harnesses['claude-code']?.flags).toEqual(['--remote-control']);
    expect(service.restarts).toBe(1);
    expect(report).toMatchObject({ configuration: 'changed', service: 'restarted' });
    expect(prompter.isDone).toBe(true);
  });

  it('keeps or drops each repository it offers, as answered', async () => {
    await init({}, new ScriptedPrompter([['Change the configuration', true], ['--dangerously-skip-permissions', false], ['--remote-control', false], ['repository', 'aeolus-fleet'], ['aeolus-fleet', repository], ['repository', ''], ['folder', ''], ['ships', '4'], ['sessions', '2'], ['Restart', false]]));

    await init({}, new ScriptedPrompter([['Change the configuration', true], ['--dangerously-skip-permissions', false], ['--remote-control', false], ['Keep the repository aeolus-fleet', false], ['repository', ''], ['folder', ''], ['ships', '4'], ['sessions', '2'], ['Restart', false]]));

    expect(configuration().repositories).toEqual({});
  });

  it('adds named folders it may crew a ship in as they are, and trusts each for Claude Code', async () => {
    const notes = join(home, 'notes');
    mkdirSync(notes);

    const report = await init({}, new ScriptedPrompter([['Change the configuration', true], ['--dangerously-skip-permissions', false], ['--remote-control', false], ['repository', ''], ['folder', 'notes'], ['notes', '~/notes'], ['folder', ''], ['ships', '4'], ['sessions', '2'], ['Restart', false]]));

    expect(configuration().folders).toEqual({ notes: { path: notes } });
    expect(report.trusted).toEqual([paths.worktrees, notes]);
  });

  it('asks again for a folder name that is no name, and for a folder that is not there', async () => {
    const notes = join(home, 'notes');
    mkdirSync(notes);
    const prompter = new ScriptedPrompter([
      ['Change the configuration', true],
      ['--dangerously-skip-permissions', false],
      ['--remote-control', false],
      ['repository', ''],
      ['folder', 'My Notes'],
      ['folder', 'notes'],
      ['notes', join(home, 'nowhere')],
      ['notes', notes],
      ['folder', ''],
      ['ships', '4'],
      ['sessions', '2'],
      ['Restart', false],
    ]);

    await init({}, prompter);

    expect(configuration().folders).toEqual({ notes: { path: notes } });
    expect(prompter.said).toContain('My Notes is no name: lowercase letters, digits and hyphens.');
    expect(prompter.said).toContain(`${join(home, 'nowhere')} is no folder.`);
  });

  it('keeps or drops each folder it offers, as answered', async () => {
    const notes = join(home, 'notes');
    mkdirSync(notes);
    writeFileSync(paths.config, JSON.stringify({ ...configuration(), folders: { notes: { path: notes } } }));

    await init({}, new ScriptedPrompter([['Change the configuration', true], ['--dangerously-skip-permissions', false], ['--remote-control', false], ['repository', ''], ['Keep the folder notes', false], ['folder', ''], ['ships', '4'], ['sessions', '2'], ['Restart', false]]));

    expect(configuration().folders).toEqual({});
  });

  it('keeps everything else the configuration holds: folders, options and the worktree root', async () => {
    const custom = { ...configuration(), worktreeRoot: join(home, 'worktrees'), folders: { notes: { path: '/notes' } }, harnesses: { 'claude-code': { flags: ['--verbose'], options: { model: { values: { opus: ['--model', 'claude-opus-5-5'] }, default: 'opus' } } } } };
    writeFileSync(paths.config, JSON.stringify(custom));

    await init({}, new ScriptedPrompter([['Change the configuration', true], ['--dangerously-skip-permissions', false], ['--remote-control', true], ['repository', ''], ['Keep the folder notes', true], ['folder', ''], ['ships', '4'], ['sessions', '2'], ['Restart', false]]));

    expect(configuration()).toEqual({ ...custom, harnesses: { 'claude-code': { ...custom.harnesses['claude-code'], flags: ['--verbose', '--remote-control'] } } });
    await expect(createClaudeCodeSetup({ homeDirectory: home }).isTrusted(join(home, 'worktrees'))).resolves.toBe(true);
  });

  it('trusts every configured folder for Claude Code too, a folder added since among them, so a crew request for a folder never waits on the trust question', async () => {
    const notes = join(home, 'notes');
    mkdirSync(notes);
    writeFileSync(paths.config, JSON.stringify({ ...configuration(), folders: { notes: { path: notes } } }));

    const report = await init({ isYes: true });

    await expect(createClaudeCodeSetup({ homeDirectory: home }).isTrusted(notes)).resolves.toBe(true);
    expect(report.trusted).toEqual([paths.worktrees, notes]);
  });

  it('refuses a ship id or secret given again, saying how to register another ship', async () => {
    await expect(init({ shipId: newId('ship'), secret: SECRET })).rejects.toThrow(`init never registers again: to register another ship, remove ${paths.crewToken} first`);
    expect(registered).toEqual([]);
  });

  it('keeps the configuration with --yes', async () => {
    const before = readFileSync(paths.config, 'utf8');

    await expect(init({ isYes: true })).resolves.toMatchObject({ configuration: 'kept' });
    expect(readFileSync(paths.config, 'utf8')).toBe(before);
  });
});

describe('aeolus-trierarch init, for Codex', () => {
  /** A configuration that offers Codex, with a repository and a folder. */
  function withCodex(): void {
    const notes = join(home, 'notes');
    mkdirSync(notes);
    mkdirSync(paths.home, { recursive: true });
    const offered: TrierarchConfiguration = {
      caps: { ships: 4, running: 2 },
      repositories: { 'aeolus-fleet': { path: repository } },
      folders: { notes: { path: notes } },
      harnesses: { codex: { flags: [], options: {} } },
    };
    writeFileSync(paths.config, JSON.stringify(offered));
    writeFileSync(paths.crewToken, `fleetUrl=${FLEET_URL}\nshipId=${newId('ship')}\ncrewToken=aeolus_ct_v1_trierarch\n`, { mode: 0o600 });
  }

  it('asks nothing about Codex where it is neither installed nor configured', async () => {
    const prompter = new ScriptedPrompter(defaults());

    await init({ fleetUrl: FLEET_URL, shipId: newId('ship'), secret: SECRET }, prompter);

    expect(prompter.asked.join('\n')).not.toContain('Codex');
    expect(configuration().harnesses.codex).toBeUndefined();
  });

  it('offers Codex where it is installed, with the flags as answered', async () => {
    const [skip, remote, ...rest] = defaults();
    const prompter = new ScriptedPrompter([skip ?? ['', false], remote ?? ['', false], ['Offer Codex', true], ['--dangerously-bypass-approvals-and-sandbox', true], ...rest]);

    isCodexInstalled = true;

    await init({ fleetUrl: FLEET_URL, shipId: newId('ship'), secret: SECRET }, prompter);

    expect(prompter.isDone).toBe(true);
    expect(configuration().harnesses.codex).toEqual({ flags: ['--dangerously-bypass-approvals-and-sandbox'], options: {} });
    expect(prompter.asked.join('\n')).not.toContain('--no-daemon');
  });

  it('trusts each configured repository and folder for Codex, since a repository covers its worktrees and a parent folder covers no repository', async () => {
    withCodex();

    const report = await init({ isYes: true });

    expect(codex.trusted).toEqual([repository, join(home, 'notes')]);
    expect(report.codexTrusted).toEqual([repository, join(home, 'notes')]);
  });

  it("trusts the aeolus plugin's hooks for Codex, so its sessions mark their turns and the trierarch can wake them", async () => {
    withCodex();

    const report = await init({ isYes: true });

    expect([...codex.hooks.values()]).toEqual(['trusted', 'trusted']);
    expect(report.codexHooksTrusted).toHaveLength(2);
  });

  it('says so when Codex cannot be set up, and finishes the rest of the setup', async () => {
    withCodex();
    codex.isMissing = true;

    const report = await init({ isYes: true });

    expect(report.said.join('\n')).toContain('Codex is not set up: Codex is not installed');
    expect(report.codexTrusted).toEqual([]);
  });

  it('leaves Codex alone where the configuration does not offer it', async () => {
    await init({ fleetUrl: FLEET_URL, shipId: newId('ship'), secret: SECRET, isYes: true });

    expect(codex.trusted).toEqual([]);
  });
});

describe("init's detection (#365)", () => {
  it("detects the configured harnesses' options and says what it found, keeping a detection of the same version", async () => {
    const at = new Date('2026-10-08T15:00:00.000Z');
    detected = { 'claude-code': { version: '2.1.293', detectedAt: at, confirmedAt: at, options: { model: { values: { 'claude-opus-5-5': ['--model', 'claude-opus-5-5'] } } } } };

    const report = await init({ fleetUrl: FLEET_URL, shipId: newId('ship'), secret: SECRET, isYes: true });

    expect(detections).toEqual([{ harnesses: ['claude-code'], isForced: false }]);
    expect(report.said).toContain('claude-code 2.1.293: model claude-opus-5-5; models confirmed 2026-10-08T15:00:00.000Z');
  });
});
