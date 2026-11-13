import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { aCrewingMachine, isRunning, listedEntryOf, REPOSITORY, sessionOf } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine } from './support/machine.js';

// Sessions in containers (decision 0039; docs/trierarch.md, "Session runtime"): run checks the runtime and refuses one that cannot hold a session to its ship; each session then runs in a container of its own, run by its hold, with its ship's own home.
// Its workspace is a clone of its own in place of a worktree, at the same path, holding its own objects, with the repository's own remote as its origin, so git works inside and no ship reaches another's.

const CREWED_WITHIN_MS = 30_000;
const ANSWERED_WITHIN_MS = 30_000;
const MODEL_TOKEN = 'sk-ant-oat01-contract-token-not-real';
const KEY = 'sk-ant-api03-contract-key-not-real';
const RUNTIME = { kind: 'container', binary: 'podman', memory: '4g', cpus: 2 };
const SESSION_IMAGE = 'ghcr.io/thomashendrickx/aeolus-session';
/** A pass runs every 5 seconds. */
const SAID_WITHIN_MS = 30_000;

const IDENTITY = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (folder: string, ...args: string[]): string => execFileSync('git', ['-C', folder, ...args], { env: { ...process.env, ...IDENTITY }, encoding: 'utf8' }).trim();

const configurationSchema = z.looseObject({ harnesses: z.record(z.string(), z.unknown()), repositories: z.record(z.string(), z.looseObject({ path: z.string() })) });

let fleet: Fleet;
let machine: Machine;

afterEach(async ({ task }) => {
  if (task.result?.state === 'fail') {
    console.log(`The service's log:\n${machine.serviceLog()}`);
  }
  // A folder a test's session made read-only is made writable again so the machine can go; a workspace that goes meanwhile is no matter.
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

  it("refuses a Podman without pasta, which gives a container the trierarch's proxy port and nothing else of the host", async () => {
    configure((configuration) => ({ ...configuration, runtime: RUNTIME }));
    writeModelToken();
    machine.toggle('podman-no-pasta', true);

    const ran = await machine.trierarch(['config', 'check']);

    expect(ran.stdout + ran.stderr).toContain(refusalOf("podman has no pasta: install passt, which gives a container the trierarch's proxy port and nothing else of the host"));
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
  const container = (): string => `trierarch-${scout}`;
  const shipHome = (): string => join(machine.trierarchHome, 'ships', scout, 'home');
  const run = (): string[] => machine.containerRunOf(container()) ?? [];

  /** Configures the container runtime, and crews scout in it. */
  async function aRunningScout(at: { login?: 'api-key' } = {}): Promise<void> {
    configure((configuration) => ({ ...configuration, runtime: RUNTIME }));
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
    await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });
    await expect.poll(async () => (await listedEntryOf(machine, scout))?.state, { timeout: CREWED_WITHIN_MS }).toBe('running');
    await expect.poll(() => sessionOf(machine, 'scout').turns().length, { timeout: CREWED_WITHIN_MS }).toBeGreaterThan(0);
  }

  beforeEach(async () => {
    fleet = await aFleet();
    machine = await aMachine();
    await aCrewingMachine({ fleet, machine });
  });

  it("runs in a container of the session image of the trierarch's version, run by its hold, capped, seeing only its folder, its own home, and its socket", async () => {
    await aRunningScout();
    const version = z.object({ version: z.string() }).parse(JSON.parse((await machine.trierarch(['--version', '--json'])).stdout)).version;
    const folder = sessionOf(machine, 'scout').folder;
    const sockets = join(machine.trierarchHome, 'ships', scout, 'sockets');
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
    const folder = sessionOf(machine, 'scout').folder;
    const crews = join(shipHome(), '.aeolus', 'crews');

    const identities = readdirSync(crews, { recursive: true, encoding: 'utf8' })
      .map((name) => join(crews, name))
      .filter((path) => statSync(path).isFile())
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    const claude = z.looseObject({ hasCompletedOnboarding: z.boolean(), projects: z.record(z.string(), z.looseObject({ hasTrustDialogAccepted: z.boolean() })) }).parse(JSON.parse(readFileSync(join(shipHome(), '.claude.json'), 'utf8')));

    expect(identities).toContain('shipName=scout');
    expect(existsSync(join(machine.home, '.aeolus', 'crews', 'claude-code')) ? readdirSync(join(machine.home, '.aeolus', 'crews', 'claude-code')) : []).toEqual([]);
    expect(claude.hasCompletedOnboarding).toBe(true);
    expect(claude.projects[folder]?.hasTrustDialogAccepted).toBe(true);
  });

  it("calls the fleet over its ship's socket from inside its container, as the ship", async () => {
    await aRunningScout();
    const socket = join(machine.trierarchHome, 'ships', scout, 'sockets', 'fleet.sock');
    const calls = join(sessionOf(machine, 'scout').folder, 'fake-socket-calls.jsonl');

    await fleet.send('scout', `socket call: ${Buffer.from(JSON.stringify({ socket, method: 'POST', path: '/api/v1/fleet/list', body: '{}' })).toString('base64url')}`);

    await expect.poll(() => existsSync(calls), { timeout: ANSWERED_WITHIN_MS }).toBe(true);
    const answered = z.object({ status: z.number(), body: z.string() }).parse(JSON.parse(readFileSync(calls, 'utf8').split('\n')[0] ?? ''));
    expect(answered.status, answered.body).toBe(200);
    expect(answered.body).toContain('"scout"');
  });

  it("reaches the model proxy's port alone, on its own loopback, on an API key, with no model token", async () => {
    await aRunningScout({ login: 'api-key' });
    const port = readFileSync(join(machine.trierarchHome, 'proxy', 'port'), 'utf8').trim();

    const env = sessionOf(machine, 'scout').starts()[0]?.env ?? {};

    expect(env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${port}/anthropic`);
    expect(env.ANTHROPIC_AUTH_TOKEN).toEqual(expect.any(String));
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(run()).toEqual(expect.arrayContaining(['--env', 'ANTHROPIC_AUTH_TOKEN', '--network', `pasta:--no-map-gw,-t,none,-u,none,-T,${port},-U,none`]));
  });

  it("keeps no token in its ship's folder: the model token, the crew token and the env file stay in the trierarch's own files beside ships/", async () => {
    await aRunningScout();
    const ships = join(machine.trierarchHome, 'ships');
    const crewToken = z.object({ entries: z.record(z.string(), z.looseObject({ crewToken: z.string() })) }).parse(JSON.parse(readFileSync(join(machine.trierarchHome, 'state.json'), 'utf8'))).entries[scout]?.crewToken ?? '';
    const files = readdirSync(ships, { recursive: true, encoding: 'utf8' })
      .map((name) => join(ships, name))
      .filter((path) => lstatSync(path).isFile())
      // The harness's stand-in writes down the environment it was given, the model token in it, as the session's own file.
      .filter((path) => !basename(path).startsWith('fake-'));

    const holding = files.filter((path) => [MODEL_TOKEN, crewToken].some((token) => readFileSync(path, 'utf8').includes(token)));

    expect(crewToken).not.toBe('');
    expect(holding).toEqual([]);
    expect(existsSync(join(machine.trierarchHome, 'sessions', scout, 'session.env'))).toBe(true);
  });

  it("ends with its container, and its ship's folder goes with its home, when its crew request is removed", async () => {
    await aRunningScout();

    await fleet.removeCrewRequest(scout);

    await expect.poll(() => existsSync(join(machine.trierarchHome, 'ships', scout)), { timeout: CREWED_WITHIN_MS }).toBe(false);
    expect(machine.callsOf('podman')).toEqual(expect.arrayContaining([`kill ${container()}`, `rm --force ${container()}`]));
  });
});

describe("a ship's clone in containers", () => {
  let scout: ShipId;

  /** Configures the container runtime and crews scout in a workspace of the machine's repository. */
  async function aCrewedScout(): Promise<string> {
    configure((configuration) => ({ ...configuration, runtime: RUNTIME }));
    writeModelToken();
    const restart = await machine.trierarch(['restart']);
    expect(restart.status, restart.stdout + restart.stderr).toBe(0);
    scout = await fleet.commission('scout', { scopes: ['fleet:read'] });
    await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });
    await expect.poll(async () => (await listedEntryOf(machine, scout))?.state, { timeout: CREWED_WITHIN_MS }).toBe('running');
    return sessionOf(machine, 'scout').main;
  }

  /** An upstream the machine's repository has as its origin, fetched: its URL. */
  function anUpstream(): string {
    const upstream = join(mkdtempSync(join(tmpdir(), 'trierarch-upstream-')), 'upstream.git');
    execFileSync('git', ['clone', '-q', '--bare', machine.repository, upstream]);
    git(machine.repository, 'remote', 'add', 'origin', upstream);
    git(machine.repository, 'fetch', '-q', 'origin');
    return upstream;
  }

  beforeEach(async () => {
    fleet = await aFleet();
    machine = await aMachine();
    await aCrewingMachine({ fleet, machine });
  });

  it.each(['clone', 'remote remove', 'remote add', 'fetch', 'checkout'])('removes a half-made clone when %s fails and makes a complete clone on the next pass', async (step) => {
    anUpstream();
    scout = await fleet.commission('scout', { scopes: ['fleet:read'] });
    const folder = join(machine.trierarchHome, 'ships', scout, 'repositories', 'main');
    const failed = join(machine.machine, 'clone-failed');
    const wrapper = join(machine.machine, 'bin', 'git');
    const realGit = realpathSync(join(machine.machine, 'tools', 'git'));
    const command = step === 'clone' ? 'clone --quiet --no-checkout*' : `-C ${folder} ${step}*`;
    writeFileSync(wrapper, `#!/bin/sh
case "$*" in
  "${command.slice(0, -1)}"*)
    '${realGit}' "$@" || exit $?
    touch '${failed}'
    echo 'clone setup deliberately failed' >&2
    exit 1 ;;
esac
exec '${realGit}' "$@"
`);
    chmodSync(wrapper, 0o755);
    configure((configuration) => ({ ...configuration, runtime: RUNTIME }));
    writeModelToken();
    expect((await machine.trierarch(['restart'])).status).toBe(0);
    await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });

    await expect.poll(() => existsSync(failed), { timeout: CREWED_WITHIN_MS }).toBe(true);
    await expect.poll(() => existsSync(folder)).toBe(false);
    rmSync(wrapper);

    await expect.poll(async () => (await listedEntryOf(machine, scout))?.state, { timeout: CREWED_WITHIN_MS }).toBe('running');
    expect(git(folder, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    expect(git(folder, 'remote', 'get-url', 'origin')).toBe(git(machine.repository, 'remote', 'get-url', 'origin'));
    expect(readFileSync(join(folder, 'README.md'), 'utf8')).toBe('hello\n');
  });

  it("is a clone of its own as the ship folder's main/, with a .git of its own holding its own objects, detached at the repository's commit, so git works inside", async () => {
    const folder = await aCrewedScout();

    expect(folder).toBe(join(machine.trierarchHome, 'ships', scout, 'repositories', 'main'));
    expect(statSync(join(folder, '.git')).isDirectory()).toBe(true);
    expect(existsSync(join(folder, '.git', 'objects', 'info', 'alternates'))).toBe(false);
    expect(git(folder, 'rev-parse', 'HEAD')).toBe(git(machine.repository, 'rev-parse', 'HEAD'));
    expect(git(folder, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    expect(git(machine.repository, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '))).toEqual([`worktree ${realpathSync(machine.repository)}`]);
  });

  it("has the repository's own remote as its origin, with its remote branches as the repository last fetched them", async () => {
    const upstream = anUpstream();

    const folder = await aCrewedScout();

    expect(git(folder, 'remote')).toBe('origin');
    expect(git(folder, 'remote', 'get-url', 'origin')).toBe(upstream);
    expect(git(folder, 'rev-parse', 'refs/remotes/origin/main')).toBe(git(machine.repository, 'rev-parse', 'refs/remotes/origin/main'));
  });

  it('has no remote when the repository has none, never the repository itself', async () => {
    const folder = await aCrewedScout();

    expect(git(folder, 'remote')).toBe('');
  });

  it('goes when its crew request is removed', async () => {
    const folder = await aCrewedScout();

    await fleet.removeCrewRequest(scout);

    await expect.poll(() => existsSync(folder), { timeout: CREWED_WITHIN_MS }).toBe(false);
  });

  for (const hasUnsavedWork of [false, true]) {
    it(`stops what runs in an orphan clone after restart and removes it${hasUnsavedWork ? ', unsaved work and all' : ''}`, async () => {
      const folder = await aCrewedScout();
      expect((await machine.trierarch(['stop'])).status).toBe(0);
      const stray = join(machine.trierarchHome, 'ships', REPOSITORY, 'stray');
      mkdirSync(dirname(stray), { recursive: true });
      renameSync(folder, stray);
      if (hasUnsavedWork) {
        writeFileSync(join(stray, 'unsaved.txt'), 'unsaved\n');
      }
      const child = spawn('sleep', ['600'], { cwd: stray, stdio: 'ignore' });
      const pid = child.pid;
      if (pid === undefined) {
        throw new Error('sleep did not start');
      }
      try {
        expect((await machine.trierarch(['restart'])).status).toBe(0);
        await expect.poll(() => isRunning(pid), { timeout: SAID_WITHIN_MS }).toBe(false);
        await expect.poll(() => existsSync(stray), { timeout: SAID_WITHIN_MS }).toBe(false);
      } finally {
        if (isRunning(pid)) {
          process.kill(pid, 'SIGKILL');
        }
      }
    });
  }

  it('removes a plain clone and a folder git does not know that no ship works in, with what runs in them stopped first (gap rule 2)', async () => {
    await aCrewedScout();
    const plain = join(machine.trierarchHome, 'ships', REPOSITORY, 'own-clone');
    const unknown = join(machine.trierarchHome, 'ships', REPOSITORY, 'notes');
    mkdirSync(plain, { recursive: true });
    mkdirSync(unknown, { recursive: true });
    const children = [plain, unknown].map((cwd) => spawn('sleep', ['600'], { cwd, stdio: 'ignore' }));
    const pids = children.flatMap((child) => (child.pid === undefined ? [] : [child.pid]));
    try {
      execFileSync('git', ['clone', '-q', machine.repository, plain]);
      writeFileSync(join(unknown, 'notes.md'), 'no repository\n');

      for (const folder of [plain, unknown]) {
        await expect.poll(() => machine.serviceLog(), { timeout: SAID_WITHIN_MS }).toContain(`Removed ${folder}, a folder under the root no crewed ship uses, after stopping 1 process in it`);
        expect(existsSync(folder)).toBe(false);
      }
      expect(pids.filter(isRunning)).toEqual([]);
    } finally {
      for (const pid of pids.filter(isRunning)) {
        process.kill(pid, 'SIGKILL');
      }
    }
  });
});
