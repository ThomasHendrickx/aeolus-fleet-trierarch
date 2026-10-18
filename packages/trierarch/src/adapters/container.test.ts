import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../../test/support/in-memory.js';
import { buildTestSessionImage, rootlessPodman } from '../../test/support/podman.js';
import { sessionRuntimeContract } from '../../test/support/session-runtime-contract.js';
import type { SessionRuntime } from '../core/ports.js';
import { createContainerRuntime, MODEL_TOKEN_VARIABLE } from './container.js';
import { heldCommand } from './held-command.js';
import { runCommand, type CommandResult } from './run-command.js';

const podman = await rootlessPodman({ platform: process.platform, info: () => runCommand('podman', { args: ['info', '--format', '{{.Host.Security.Rootless}}'] }) });

/** A token that only looks like one: the tests never hold a real model login. */
const MODEL_TOKEN = 'sk-ant-oat01-test-token';

const CAPS = { memory: '512m', cpus: 1 };

// Against the real rootless Podman, with an image built in place from this
// machine's own tmux, so nothing is pulled (#464), and a label of the test's
// own, so the machine's own trierarch containers are left alone.
describe('the session runtime contract, on rootless Podman', () => {
  let image = '';
  let owner: string;
  let folder: string;
  /** Where the ships' homes are kept, apart from the folder, as on the machine. */
  let homes: string;
  let runtime: SessionRuntime;

  // First, so a skip runs neither the setup nor the cleanup, which need podman.
  beforeEach((context) => {
    if (!podman.isUsable) {
      context.skip(podman.reason);
    }
  });

  beforeAll(async () => {
    if (podman.isUsable) {
      image = await buildTestSessionImage(`localhost/aeolus-trierarch-test:${newId('ship').slice(-8)}`);
    }
  }, 60_000);

  afterAll(async () => {
    if (image !== '') {
      await runCommand('podman', { args: ['image', 'rm', '--force', image] });
    }
  });

  beforeEach(() => {
    owner = `trierarch-test-${newId('ship').slice(-8)}`;
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'trierarch-container-')));
    const tokenFile = join(folder, 'model-token');
    writeFileSync(tokenFile, `${MODEL_TOKEN}\n`, { mode: 0o600 });
    homes = realpathSync(mkdtempSync(join(tmpdir(), 'trierarch-homes-')));
    runtime = createContainerRuntime({ binary: 'podman', image, owner, tokenFile, homes, ...CAPS });
  });

  afterEach(async () => {
    const containers = await runCommand('podman', { args: ['ps', '--all', '--quiet', '--filter', `label=aeolus.trierarch=${owner}`] });
    const ids = containers.stdout.split('\n').filter((id) => id !== '');
    if (ids.length > 0) {
      await runCommand('podman', { args: ['rm', '--force', '--time', '0', ...ids] });
    }
    rmSync(folder, { recursive: true, force: true });
    rmSync(homes, { recursive: true, force: true });
  });

  sessionRuntimeContract({ runtime: () => runtime, folder: () => folder });

  it('hands the session the model token', async () => {
    const shipId = newId('ship');

    await runtime.start({ shipId, folder, command: ['sh', '-c', `[ "$${MODEL_TOKEN_VARIABLE}" = "${MODEL_TOKEN}" ] && echo "token handed"; sleep 30`] });

    await expect.poll(async () => runtime.screen(shipId), { timeout: 5000 }).toContain('token handed');
  });

  it("gives the session its own ship's home as its home, and nothing of another ship's", async () => {
    const [scout, other] = [newId('ship'), newId('ship')];
    for (const [shipId, name] of [
      [scout, 'scout'],
      [other, 'other'],
    ] as const) {
      mkdirSync(join(homes, shipId));
      writeFileSync(join(homes, shipId, `${name}.identity`), `shipName=${name}\n`);
    }

    // Only the shell's builtins: the test image holds no ls or cat.
    await runtime.start({
      shipId: scout,
      folder,
      command: ['sh', '-c', `cd; echo "home $(pwd)"; for file in * .*; do echo "holds $file"; done; read line < ${join(homes, other, 'other.identity')} && echo "read $line"; sleep 30`],
    });

    await expect.poll(async () => runtime.screen(scout), { timeout: 5000 }).toContain('holds scout.identity');
    const screen = await runtime.screen(scout);
    expect({ home: screen.includes('home /home/ubuntu'), other: screen.includes('holds other.identity'), read: screen.includes('read shipName') }).toEqual({ home: true, other: false, read: false });
  });

  it("makes the ship's home when it has none yet, for its owner alone", async () => {
    const shipId = newId('ship');

    await runtime.start({ shipId, folder, command: ['sleep', '30'] });

    expect(statSync(join(homes, shipId)).mode & 0o777).toBe(0o700);
  });

  it('caps the memory and the cpus of the container', async () => {
    const shipId = newId('ship');

    await runtime.start({ shipId, folder, command: ['sleep', '30'] });

    const limits = await runCommand('podman', { args: ['inspect', '--format', '{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}', `trierarch-${shipId}`] });
    expect(limits.stdout.trim()).toBe(`${String(512 * 1024 * 1024)} ${String(1_000_000_000)}`);
  });
});

/** A runner that answers every command as done, saying what it was asked, and the env file each one named as it was when the command ran. */
function recordingRunner(answer: (args: readonly string[]) => Partial<CommandResult> = () => ({})) {
  const calls: { command: string; args: readonly string[]; envFile?: string }[] = [];
  const run = (command: string, options: { args: readonly string[] }): Promise<CommandResult> => {
    const at = options.args.indexOf('--env-file');
    const path = at === -1 ? undefined : options.args[at + 1];
    calls.push({ command, args: options.args, ...(path !== undefined && { envFile: path }) });
    return Promise.resolve({ status: 0, stdout: '', stderr: '', ...answer(options.args) });
  };
  return { calls, run, runs: () => calls.filter((call) => call.args.includes('run')) };
}

describe('the container a session runs in', () => {
  const shipId = newId('ship');
  const folder = '/home/thomas/.aeolus/trierarch/worktrees/aeolus-fleet/implementer-b';
  let tokenFolder: string;
  let tokenFile: string;
  /** The ships' homes, in a folder of the test's own: the runtime makes a home as it starts a container. */
  let homes: string;

  beforeEach(() => {
    tokenFolder = mkdtempSync(join(tmpdir(), 'trierarch-token-'));
    tokenFile = join(tokenFolder, 'model-token');
    writeFileSync(tokenFile, `${MODEL_TOKEN}\n`, { mode: 0o600 });
    homes = join(tokenFolder, 'homes');
  });

  afterEach(() => {
    rmSync(tokenFolder, { recursive: true, force: true });
  });

  function runtimeWith(runner: ReturnType<typeof recordingRunner>, options: { launch?: readonly string[]; binary?: string } = {}): SessionRuntime {
    return createContainerRuntime({ binary: options.binary ?? 'podman', image: 'ghcr.io/thomashendrickx/aeolus-session:0.25.0', tokenFile, homes, ...CAPS, run: runner.run, ...(options.launch !== undefined && { launch: options.launch }) });
  }

  async function started(options: { launch?: readonly string[]; binary?: string; env?: Record<string, string> } = {}) {
    const runner = recordingRunner();
    await runtimeWith(runner, options).start({ shipId, folder, command: ['claude', '--name', 'implementer-b'], ...(options.env !== undefined && { env: options.env }) });
    const [run] = runner.runs();
    if (run === undefined) {
      throw new Error('no container was run');
    }
    return { runner, run };
  }

  /** The values a flag of the runtime's own takes: those before the image, not the session command's. */
  const valuesOf = (args: readonly string[], flag: string) => {
    const image = args.indexOf('ghcr.io/thomashendrickx/aeolus-session:0.25.0');
    const own = image === -1 ? args : args.slice(0, image);
    return own.flatMap((arg, at) => (arg === flag ? [own[at + 1] ?? ''] : []));
  };

  it('runs the configured binary', async () => {
    const { run } = await started({ binary: 'docker' });

    expect(run.command).toBe('docker');
  });

  it('runs one container per ship, named after its ship id, detached, from the image', async () => {
    const { run } = await started();

    expect({ name: valuesOf(run.args, '--name'), isDetached: run.args.includes('--detach'), hasImage: run.args.includes('ghcr.io/thomashendrickx/aeolus-session:0.25.0') }).toEqual({ name: [`trierarch-${shipId}`], isDetached: true, hasImage: true });
  });

  it('removes the ship\'s container before it runs a new one, so an exited one is replaced', async () => {
    const { runner } = await started();

    expect(runner.calls.map((call) => call.args[0])).toEqual(['kill', 'rm', 'run']);
  });

  it('caps the memory and the cpus as configured', async () => {
    const { run } = await started();

    expect({ memory: valuesOf(run.args, '--memory'), cpus: valuesOf(run.args, '--cpus') }).toEqual({ memory: ['512m'], cpus: ['1'] });
  });

  it('caps memory and swap together at the configured memory, so the runtime does not double the cap with swap', async () => {
    const { run } = await started();

    expect(valuesOf(run.args, '--memory-swap')).toEqual(['512m']);
  });

  it("runs the session's command held a moment after it ends, so its last output reaches the screen (#888)", async () => {
    const { run } = await started();

    expect(run.args.slice(-heldCommand(['claude', '--name', 'implementer-b']).length)).toEqual(heldCommand(['claude', '--name', 'implementer-b']));
  });

  it('caps the processes of the container, so a fork bomb in one session cannot starve the machine', async () => {
    const { run } = await started();

    expect(valuesOf(run.args, '--pids-limit')).toEqual(['4096']);
  });

  it('runs as the session user with the flags a nested rootless Podman needs', async () => {
    const { run } = await started();

    expect(run.args).toEqual(expect.arrayContaining(['--userns=keep-id:uid=1000,gid=1000', '--device', '/dev/fuse', '--device', '/dev/net/tun', '--cap-add', 'SYS_ADMIN', '--security-opt', 'unmask=ALL']));
  });

  it("mounts only the session's folder, at its own path, and its ship's own home as the container's home, so never the runtime's socket", async () => {
    const { run } = await started();

    expect({ volumes: valuesOf(run.args, '--volume'), workdir: valuesOf(run.args, '--workdir'), home: valuesOf(run.args, '--env'), others: run.args.filter((arg) => arg.startsWith('-v') || arg.startsWith('--mount')) }).toEqual({
      volumes: [`${folder}:${folder}`, `${homes}/${shipId}:/home/ubuntu`],
      workdir: [folder],
      home: ['HOME=/home/ubuntu'],
      others: [],
    });
  });

  it('gives the container no restart policy: the trierarch starts a dead one again itself', async () => {
    const { run } = await started();

    expect(run.args.filter((arg) => arg.startsWith('--restart'))).toEqual([]);
  });

  it('hands the model token through an env file, never on a command line (#445)', async () => {
    const { runner, run } = await started();

    expect({ onCommandLine: runner.calls.some((call) => call.args.some((arg) => arg.includes(MODEL_TOKEN))), hasEnvFile: run.envFile !== undefined }).toEqual({ onCommandLine: false, hasEnvFile: true });
  });

  it('writes the env file for its owner alone and removes it once the container runs', async () => {
    let seen: { content: string; mode: number } | undefined;
    const runner = recordingRunner((args) => {
      if (args.includes('--env-file')) {
        const path = args[args.indexOf('--env-file') + 1] ?? '';
        seen = { content: readFileSync(path, 'utf8'), mode: statSync(path).mode & 0o777 };
      }
      return {};
    });

    await runtimeWith(runner).start({ shipId, folder, command: ['claude'], env: { AEOLUS_LAUNCH: 'launch-1' } });

    const [run] = runner.runs();
    expect({ seen, isRemoved: !existsSync(run?.envFile ?? '') }).toEqual({ seen: { content: `AEOLUS_LAUNCH=launch-1\n${MODEL_TOKEN_VARIABLE}=${MODEL_TOKEN}\n`, mode: 0o600 }, isRemoved: true });
  });

  it("hands the session's environment through the env file too, not on a command line", async () => {
    const { runner } = await started({ env: { AEOLUS_LAUNCH: 'launch-1' } });

    expect(runner.calls.some((call) => call.args.some((arg) => arg.includes('launch-1')))).toBe(false);
  });

  it('refuses an environment value of more than one line, which an env file cannot hold', async () => {
    const runner = recordingRunner();

    await expect(runtimeWith(runner).start({ shipId, folder, command: ['claude'], env: { AEOLUS_LAUNCH: 'one\ntwo' } })).rejects.toThrow('AEOLUS_LAUNCH');
  });

  it("runs the container through the launch command, so under a systemd unit it lives outside the service's control group (#479, #537)", async () => {
    const { runner } = await started({ launch: ['systemd-run', '--user', '--scope', '--quiet', '--collect', '--'] });

    expect(runner.calls.map((call) => [call.command, call.args[0]])).toEqual([
      ['podman', 'kill'],
      ['podman', 'rm'],
      ['systemd-run', '--user'],
    ]);
  });

  it("lists only this trierarch's containers, an exited one kept", async () => {
    const other = newId('ship');
    const runner = recordingRunner((args) => (args[0] === 'ps' ? { stdout: `trierarch-${shipId} running\ntrierarch-${other} exited\nsomeone-else running\n` } : {}));

    const sessions = await runtimeWith(runner).list();

    expect({ sessions, filter: valuesOf(runner.calls[0]?.args ?? [], '--filter') }).toEqual({
      sessions: [
        { shipId, status: 'running' },
        { shipId: other, status: 'exited' },
      ],
      filter: ['label=aeolus.trierarch=aeolus-trierarch'],
    });
  });
});
