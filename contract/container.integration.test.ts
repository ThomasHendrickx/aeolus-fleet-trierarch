import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { aCrewingMachine, listedEntryOf, REPOSITORY, sessionOf } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine } from './support/machine.js';

// Sessions in containers (decision 0039; docs/trierarch.md, "Session runtime"): run checks the runtime and refuses one that cannot hold a session to its ship; each session then runs in a container of its own, run by its hold, with its ship's own home.

const CREWED_WITHIN_MS = 30_000;
const ANSWERED_WITHIN_MS = 30_000;
const MODEL_TOKEN = 'sk-ant-oat01-contract-token-not-real';
const KEY = 'sk-ant-api03-contract-key-not-real';
const RUNTIME = { kind: 'container', binary: 'podman', memory: '4g', cpus: 2 };
const SESSION_IMAGE = 'ghcr.io/thomashendrickx/aeolus-session';

const IDENTITY = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (folder: string, ...args: string[]): string => execFileSync('git', ['-C', folder, ...args], { env: { ...process.env, ...IDENTITY }, encoding: 'utf8' }).trim();

const configurationSchema = z.looseObject({ harnesses: z.record(z.string(), z.unknown()), repositories: z.record(z.string(), z.looseObject({ path: z.string() })) });

let fleet: Fleet;
let machine: Machine;

afterEach(async ({ task }) => {
  if (task.result?.state === 'fail') {
    console.log(`The service's log:\n${machine.serviceLog()}`);
  }
  // Read-only checkouts a test left are made writable again so the machine can go; a workspace that goes meanwhile is no matter.
  spawnSync('chmod', ['-R', 'u+w', machine.trierarchHome]);
  await machine.remove();
  await fleet.close();
});

const configFile = (): string => join(machine.trierarchHome, 'config.json');
const modelTokenFile = (): string => join(machine.trierarchHome, 'model-token');

/** Changes the machine's configuration as the operator does by hand. */
function configure(change: (configuration: z.infer<typeof configurationSchema>) => Record<string, unknown>): void {
  writeFileSync(configFile(), JSON.stringify(change(configurationSchema.parse(JSON.parse(readFileSync(configFile(), 'utf8'))))));
}

function writeModelToken(): void {
  writeFileSync(modelTokenFile(), `${MODEL_TOKEN}\n`, { mode: 0o600 });
}

describe('the container runtime check', () => {
  beforeEach(async () => {
    fleet = await aFleet();
    machine = await aMachine();
    await aCrewingMachine({ fleet, machine });
  });

  /** The refusal run and config check both say, every reason on its own line. */
  const refusalOf = (...reasons: string[]): string => [`The configuration at ${configFile()} cannot run its sessions in containers:`, ...reasons.map((reason) => `  ${reason}`)].join('\n');

  const everyRefusal = (): string =>
    refusalOf(
      'podman runs rootful: the container runtime runs rootless only, as the user that runs the trierarch',
      'the user that runs the trierarch is in the docker group, which is root on the machine: take the user out of it',
      'codex does not run in a container yet: the container runtime offers claude-code only, so remove codex',
      `the model token file ${modelTokenFile()} is missing or empty: write the token claude setup-token gives into it, readable by its owner only`,
    );

  /** A machine whose runtime runs rootful, whose user is in the docker group, with Codex configured and no model token. */
  function aMachineNoContainerHolds(): void {
    configure((configuration) => ({ ...configuration, runtime: RUNTIME, harnesses: { ...configuration.harnesses, codex: { flags: [], options: {} } } }));
    machine.toggle('podman-rootful', true);
    machine.toggle('user-in-docker-group', true);
  }

  it('refuses to run, with every reason the runtime cannot hold a session to its ship', async () => {
    aMachineNoContainerHolds();

    const ran = await machine.trierarch(['run']);

    expect(ran.status).not.toBe(0);
    expect(ran.stdout + ran.stderr).toContain(everyRefusal());
  });

  it('is what config check says too', async () => {
    aMachineNoContainerHolds();

    const ran = await machine.trierarch(['config', 'check']);

    expect(ran.status).not.toBe(0);
    expect(ran.stdout + ran.stderr).toContain(everyRefusal());
  });

  it('refuses a runtime binary that does not answer', async () => {
    configure((configuration) => ({ ...configuration, runtime: { ...RUNTIME, binary: 'no-such-podman' } }));
    writeModelToken();

    const ran = await machine.trierarch(['config', 'check']);

    expect(ran.stdout + ran.stderr).toContain(refusalOf('no-such-podman does not answer: install a rootless podman, or name the runtime binary in runtime.binary'));
  });

  it('refuses --remote-control in a harness on the host too: a session the trierarch runs has no terminal', async () => {
    configure((configuration) => ({ ...configuration, harnesses: { ...configuration.harnesses, 'claude-code': { flags: ['--remote-control'], options: {} } } }));

    const ran = await machine.trierarch(['run']);

    expect(ran.status).not.toBe(0);
    expect(ran.stdout + ran.stderr).toContain(refusalOf('claude-code launches with --remote-control: a session the trierarch runs has no terminal and no Remote Control, so remove it'));
  });

  it('lets config check say how the sessions run once the runtime holds them', async () => {
    configure((configuration) => ({ ...configuration, runtime: RUNTIME }));
    writeModelToken();

    const ran = await machine.trierarch(['config', 'check']);

    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(ran.stdout).toContain(`Sessions run in containers of podman, each capped at 4g of memory and 2 cpus, with the model token in ${modelTokenFile()}.`);
  });
});

describe('a session in a container', () => {
  let scout: ShipId;
  /** The repository the working repository names as its read-only checkout. */
  let skills: string;

  const container = (): string => `trierarch-${scout}`;
  const shipHome = (): string => join(machine.trierarchHome, 'homes', scout);
  const checkout = (): string => join(machine.trierarchHome, 'checkouts', scout, 'skills');
  const run = (): string[] => machine.containerRunOf(container()) ?? [];

  /** Configures the container runtime, with a read-only checkout of skills for the working repository, and crews scout in it. */
  async function aRunningScout(at: { login?: 'api-key' } = {}): Promise<void> {
    skills = mkdtempSync(join(tmpdir(), 'trierarch-skills-'));
    execFileSync('git', ['init', '-q', '-b', 'main', skills]);
    writeFileSync(join(skills, 'README.md'), 'skills\n');
    git(skills, 'add', '.');
    git(skills, 'commit', '-q', '-m', 'init');
    const added = await machine.trierarch(['add', 'repository', 'skills', skills]);
    expect(added.status, added.stdout + added.stderr).toBe(0);
    configure((configuration) => {
      const working = configuration.repositories[REPOSITORY];
      return { ...configuration, runtime: RUNTIME, repositories: { ...configuration.repositories, [REPOSITORY]: { ...working, checkouts: ['skills'] } } };
    });
    writeModelToken();
    if (at.login === 'api-key') {
      // The key as `login claude-code --api-key` keeps it once the vendor took it: login itself asks Anthropic, which a test does not reach.
      const keys = join(machine.trierarchHome, 'keys');
      mkdirSync(keys, { recursive: true, mode: 0o700 });
      writeFileSync(join(keys, 'claude-code'), KEY, { mode: 0o600 });
      const login = await machine.trierarch(['login', 'claude-code', '--default', 'api-key']);
      expect(login.status, login.stdout + login.stderr).toBe(0);
    }
    const restart = await machine.trierarch(['restart']);
    expect(restart.status, restart.stdout + restart.stderr).toBe(0);
    scout = await fleet.commission('scout', { scopes: ['fleet:read'] });
    await fleet.crewInWorktree(scout, { repository: REPOSITORY, harness: 'claude-code' });
    await expect.poll(async () => (await listedEntryOf(machine, scout))?.state, { timeout: CREWED_WITHIN_MS }).toBe('running');
    await expect.poll(() => sessionOf(machine, 'scout').turns().length, { timeout: CREWED_WITHIN_MS }).toBeGreaterThan(0);
  }

  beforeEach(async () => {
    fleet = await aFleet();
    machine = await aMachine();
    await aCrewingMachine({ fleet, machine });
  });

  it("runs in a container of the session image of the trierarch's version, run by its hold, capped, seeing only its folder, its own home, its socket and its read-only checkouts", async () => {
    await aRunningScout();
    const version = z.object({ version: z.string() }).parse(JSON.parse((await machine.trierarch(['--version', '--json'])).stdout)).version;
    const folder = sessionOf(machine, 'scout').worktree;
    const sockets = join(machine.trierarchHome, 'sockets', scout);
    const image = `${SESSION_IMAGE}:${version}`;

    const words = run();

    expect(words.slice(0, words.indexOf(image) + 2)).toEqual([
      'run',
      '--rm',
      '-i',
      '--name',
      container(),
      '--label',
      'aeolus.trierarch=aeolus-trierarch',
      '--memory-swap',
      '4g',
      '--memory',
      '4g',
      '--cpus',
      '2',
      '--pids-limit',
      '4096',
      '--userns=keep-id:uid=1000,gid=1000',
      '--device',
      '/dev/fuse',
      '--device',
      '/dev/net/tun',
      '--cap-add',
      'SYS_ADMIN',
      '--security-opt',
      'unmask=ALL',
      '--volume',
      `${folder}:${folder}`,
      '--volume',
      `${shipHome()}:/home/ubuntu`,
      '--volume',
      `${sockets}:${sockets}`,
      '--volume',
      `${checkout()}:${checkout()}:ro`,
      '--env',
      'HOME=/home/ubuntu',
      '--workdir',
      folder,
      '--env-file',
      join(machine.trierarchHome, 'sessions', scout, 'session.env'),
      image,
      'claude',
    ]);
  });

  it("gets the machine's model token through an env file only its owner reads, never on a command line", async () => {
    await aRunningScout();
    const envFile = join(machine.trierarchHome, 'sessions', scout, 'session.env');

    expect(sessionOf(machine, 'scout').starts()[0]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(MODEL_TOKEN);
    expect(run().join(' ')).not.toContain(MODEL_TOKEN);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
  });

  it("keeps its identity in its ship's own home, never the user's, with Claude Code's questions answered there", async () => {
    await aRunningScout();
    const folder = sessionOf(machine, 'scout').worktree;
    const crews = join(shipHome(), '.aeolus', 'crews');

    const identities = readdirSync(crews, { recursive: true, encoding: 'utf8' })
      .map((name) => join(crews, name))
      .filter((path) => statSync(path).isFile())
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    const claude = z.looseObject({ hasCompletedOnboarding: z.boolean(), projects: z.record(z.string(), z.looseObject({ hasTrustDialogAccepted: z.boolean() })) }).parse(JSON.parse(readFileSync(join(shipHome(), '.claude.json'), 'utf8')));

    expect(identities).toContain(`checkout=skills=${checkout()}`);
    expect(existsSync(join(machine.home, '.aeolus', 'crews', 'claude-code')) ? readdirSync(join(machine.home, '.aeolus', 'crews', 'claude-code')) : []).toEqual([]);
    expect(claude.hasCompletedOnboarding).toBe(true);
    expect(claude.projects[folder]?.hasTrustDialogAccepted).toBe(true);
  });

  it("calls the fleet over its ship's socket from inside its container, as the ship", async () => {
    await aRunningScout();
    const socket = join(machine.trierarchHome, 'sockets', scout, 'fleet.sock');
    const calls = join(sessionOf(machine, 'scout').worktree, 'fake-socket-calls.jsonl');

    await fleet.send('scout', `socket call: ${Buffer.from(JSON.stringify({ socket, method: 'POST', path: '/api/v1/fleet/list', body: '{}' })).toString('base64url')}`);

    await expect.poll(() => existsSync(calls), { timeout: ANSWERED_WITHIN_MS }).toBe(true);
    const answered = z.object({ status: z.number(), body: z.string() }).parse(JSON.parse(readFileSync(calls, 'utf8').split('\n')[0] ?? ''));
    expect(answered.status, answered.body).toBe(200);
    expect(answered.body).toContain('"scout"');
  });

  it('reaches the model proxy at the host address its network gives it, on an API key, with no model token', async () => {
    await aRunningScout({ login: 'api-key' });
    const port = readFileSync(join(machine.trierarchHome, 'proxy', 'port'), 'utf8').trim();

    const env = sessionOf(machine, 'scout').starts()[0]?.env ?? {};

    expect(env.ANTHROPIC_BASE_URL).toBe(`http://10.0.2.2:${port}/anthropic`);
    expect(env.ANTHROPIC_AUTH_TOKEN).toEqual(expect.any(String));
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(run()).toEqual(expect.arrayContaining(['--env', 'ANTHROPIC_AUTH_TOKEN', '--network', 'slirp4netns:allow_host_loopback=true']));
  });

  it("ends with its container, and its ship's home goes, when its crew request is removed", async () => {
    await aRunningScout();

    await fleet.removeCrewRequest(scout);

    await expect.poll(() => existsSync(shipHome()), { timeout: CREWED_WITHIN_MS }).toBe(false);
    expect(machine.callsOf('podman')).toEqual(expect.arrayContaining([`kill ${container()}`, `rm --force ${container()}`]));
  });
});
