import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TRIERARCH_PROGRAM } from '../../test/support/hold-program.js';
import { newId } from '../../test/support/in-memory.js';
import { buildTestSessionImage, rootlessPodman } from '../../test/support/podman.js';
import { sessionRuntimeContract } from '../../test/support/session-runtime-contract.js';
import { createCallerCheck } from './caller-check.js';
import { createContainerRuntime, MODEL_PROXY_HOST, MODEL_TOKEN_VARIABLE } from './container.js';
import { runCommand, type CommandResult } from './run-command.js';
import { runningVersion } from './version.js';

const podman = await rootlessPodman({ platform: process.platform, info: () => runCommand('podman', { args: ['info', '--format', '{{.Host.Security.Rootless}}'] }) });

/** A token that only looks like one: the tests never hold a real model login. */
const MODEL_TOKEN = 'sk-ant-oat01-test-token';

const CAPS = { memory: '512m', cpus: 1 };

/** The version a hold states: the trierarch's own, which runs it. */
const VERSION = runningVersion();

/** The pid of the ship's hold, from its pid file. */
const holdPidOf = (sessions: string, shipId: ShipId): number => Number(readFileSync(join(sessions, shipId, 'hold.pid'), 'utf8'));

/**
 * A stand-in for Claude Code in print mode with streamed JSON, in shell
 * builtins only, as a test image holds no more: each line it is sent starts a
 * turn that runs until it is interrupted, which the interrupt control request
 * does, answered and ended with `error_during_execution`.
 */
const STREAMED_JSON_STAND_IN = `
while read -r line; do
  case "$line" in
    *control_request*)
      id=\${line#*'"request_id":"'}; id=\${id%%'"'*}
      echo '{"type":"control_response","response":{"subtype":"success","request_id":"'"$id"'"}}'
      echo '{"type":"result","subtype":"error_during_execution"}' ;;
    *) echo "working on $line" ;;
  esac
done
`;

// Against the real rootless Podman, with an image built in place from this
// machine's own sh, sleep and nc, so nothing is pulled (#464), and a label of
// the test's own, so the machine's own trierarch containers are left alone.
// Each session runs under a real hold, the trierarch program from source.
/** A session's own token for the model proxy, as the Claude Code adapter makes one. */
const PROXY_TOKEN = { harness: 'claude-code', variable: 'ANTHROPIC_AUTH_TOKEN', token: 'aeolus-proxy-test-token' };

/** A container's start and stop take seconds on a loaded machine: each test of the real Podman gets room for both. */
const PODMAN_TEST_TIMEOUT_MS = 30_000;

describe('the session runtime contract, on rootless Podman under holds', { timeout: PODMAN_TEST_TIMEOUT_MS }, () => {
  let image = '';
  let owner: string;
  let folder: string;
  /** Where the ships' homes are kept, apart from the folder, as on the machine. */
  let homes: string;
  /** Where the ships' sockets are kept, one folder per ship, as the trierarch keeps them. */
  let sockets: string;
  /** Where the holds keep their files, one folder per ship. */
  let sessions: string;
  let runtime: ReturnType<typeof createContainerRuntime>;
  /** The ships' sockets a test listens on, closed after it. */
  const listening: NetServer[] = [];

  const aRuntime = () => createContainerRuntime({ binary: 'podman', image, owner, tokenFile: join(folder, 'model-token'), homes, sockets, sessions, program: TRIERARCH_PROGRAM, version: VERSION, platform: process.platform, ...CAPS });

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
    writeFileSync(join(folder, 'model-token'), `${MODEL_TOKEN}\n`, { mode: 0o600 });
    homes = realpathSync(mkdtempSync(join(tmpdir(), 'trierarch-homes-')));
    // Short, under /tmp: a Unix socket path is at most 104 bytes on macOS.
    sockets = realpathSync(mkdtempSync('/tmp/aeolus-sockets-'));
    sessions = realpathSync(mkdtempSync('/tmp/aeolus-holds-'));
    runtime = aRuntime();
  });

  afterEach(async () => {
    for (const session of await runtime.list()) {
      await runtime.stop(session.shipId);
    }
    const containers = await runCommand('podman', { args: ['ps', '--all', '--quiet', '--filter', `label=aeolus.trierarch=${owner}`] });
    const ids = containers.stdout.split('\n').filter((id) => id !== '');
    if (ids.length > 0) {
      await runCommand('podman', { args: ['rm', '--force', '--time', '0', ...ids] });
    }
    await Promise.all(listening.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
    for (const each of [folder, homes, sockets, sessions]) {
      rmSync(each, { recursive: true, force: true });
    }
  });

  sessionRuntimeContract({ runtime: () => runtime, folder: () => folder });

  /** What the session's harness wrote, as one text. */
  const shown = async (shipId: ShipId): Promise<string> => (await runtime.events(shipId)).join('\n');
  /** The containers of the test's own owner, by name. */
  const containerNames = async (): Promise<string[]> => (await runCommand('podman', { args: ['ps', '--all', '--filter', `label=aeolus.trierarch=${owner}`, '--format', '{{.Names}}'] })).stdout.split('\n').filter((name) => name !== '');

  it('takes a hand-over, then a forced delivery that stops the running turn with the interrupt control request, through the hold (headless H12, H18)', async () => {
    const shipId = newId('ship');
    await runtime.start({ shipId, folder, command: ['sh', '-c', STREAMED_JSON_STAND_IN], harness: 'claude-code' });
    await runtime.send({ shipId, line: 'the hand-over' });
    await expect.poll(async () => shown(shipId), { timeout: 5000 }).toContain('working on the hand-over');

    await runtime.interrupt(shipId);
    await runtime.send({ shipId, line: 'the forced one' });

    await expect.poll(async () => shown(shipId), { timeout: 5000 }).toContain('working on the forced one');
    expect(await shown(shipId)).toContain('error_during_execution');
    await expect(runtime.list()).resolves.toEqual([{ shipId, status: 'running' }]);
  });

  it('runs the container under the hold, not detached: stopping the session removes its container (H18)', async () => {
    const shipId = newId('ship');
    await runtime.start({ shipId, folder, command: ['sleep', '30'], harness: 'claude-code' });
    await expect(containerNames()).resolves.toEqual([`trierarch-${shipId}`]);

    await runtime.stop(shipId);

    await expect(containerNames()).resolves.toEqual([]);
  });

  it('lives as long as its hold: once the hold ends, its container is gone (H18)', async () => {
    const shipId = newId('ship');
    // The harness ends on SIGTERM, as Claude Code does: a shell that is the container's first process ignores it otherwise.
    await runtime.start({ shipId, folder, command: ['sh', '-c', 'trap "exit 0" TERM; echo ready; sleep 30 & wait'], harness: 'claude-code' });
    await expect.poll(async () => shown(shipId), { timeout: 10_000 }).toContain('ready');

    process.kill(holdPidOf(sessions, shipId), 'SIGTERM');

    await expect.poll(containerNames, { timeout: 10_000 }).toEqual([]);
  });

  it('runs on when the trierarch that started it is started again: a new trierarch lists it running and hands it lines', async () => {
    const shipId = newId('ship');
    await runtime.start({ shipId, folder, command: ['sh', '-c', 'while read -r line; do echo "got $line"; done'], harness: 'claude-code' });

    const restarted = aRuntime();

    await expect(restarted.list()).resolves.toEqual([{ shipId, status: 'running' }]);
    await restarted.send({ shipId, line: 'after the restart' });
    await expect.poll(async () => (await restarted.events(shipId)).join('\n'), { timeout: 5000 }).toContain('got after the restart');
  });

  it('lists a container an older trierarch started detached as of another version, and replaces it with one under a hold when the ship starts (H19)', async () => {
    const shipId = newId('ship');
    const older = await runCommand('podman', { args: ['run', '--detach', '--name', `trierarch-${shipId}`, '--label', `aeolus.trierarch=${owner}`, image, 'sleep', '30'] });
    expect(older.stderr).toBe('');

    await expect(runtime.list()).resolves.toEqual([{ shipId, status: 'running', isOtherVersion: true }]);

    await runtime.start({ shipId, folder, command: ['sleep', '30'], harness: 'claude-code' });

    await expect(runtime.list()).resolves.toEqual([{ shipId, status: 'running' }]);
    await expect(containerNames()).resolves.toEqual([`trierarch-${shipId}`]);
  });

  it("reaches the model proxy at Podman's host address on an API key, with its own proxy token, and holds no key and no model token (headless H16, api keys K7)", async () => {
    const shipId = newId('ship');
    const proxy = createHttpServer((_request, response) => response.end('the proxy answered\n'));
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const key = 'sk-ant-api03-test-key-not-real';
    mkdirSync(join(folder, 'keys'));
    writeFileSync(join(folder, 'keys', 'claude-code'), `${key}\n`, { mode: 0o600 });
    try {
      await runtime.start({
        shipId,
        folder,
        command: ['sh', '-c', `export -p; printf 'GET / HTTP/1.0\\r\\n\\r\\n' | nc -w 5 ${MODEL_PROXY_HOST} ${String(port)}; sleep 30`],
        harness: 'claude-code',
        proxyToken: PROXY_TOKEN,
      });

      await expect.poll(async () => shown(shipId), { timeout: 10_000 }).toContain('the proxy answered');
      const screen = await shown(shipId);
      expect({ token: screen.includes(`${PROXY_TOKEN.variable}='${PROXY_TOKEN.token}'`) || screen.includes(`${PROXY_TOKEN.variable}="${PROXY_TOKEN.token}"`), key: screen.includes(key), modelToken: screen.includes(MODEL_TOKEN) }).toEqual({ token: true, key: false, modelToken: false });
    } finally {
      await new Promise((resolve) => proxy.close(resolve));
    }
  });

  it('hands the session the model token', async () => {
    const shipId = newId('ship');

    await runtime.start({ shipId, folder, command: ['sh', '-c', `[ "$${MODEL_TOKEN_VARIABLE}" = "${MODEL_TOKEN}" ] && echo "token handed"; sleep 30`], harness: 'claude-code' });

    await expect.poll(async () => shown(shipId), { timeout: 5000 }).toContain('token handed');
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
      harness: 'claude-code',
    });

    await expect.poll(async () => shown(scout), { timeout: 5000 }).toContain('holds scout.identity');
    const screen = await shown(scout);
    expect({ home: screen.includes('home /home/ubuntu'), other: screen.includes('holds other.identity'), read: screen.includes('read shipName') }).toEqual({ home: true, other: false, read: false });
  });

  it("lets the session reach its own ship's socket at the path the trierarch keeps it, and no other ship's (decision 0026)", async () => {
    const [scout, other] = [newId('ship'), newId('ship')];
    for (const shipId of [scout, other]) {
      mkdirSync(join(sockets, shipId), { mode: 0o700 });
      const server = createNetServer();
      await new Promise<void>((resolve) => server.listen(join(sockets, shipId, 'fleet.sock'), resolve));
      listening.push(server);
    }

    // Only the shell's builtins: the test image holds no ls or cat.
    await runtime.start({
      shipId: scout,
      folder,
      command: ['sh', '-c', `[ -S ${join(sockets, scout, 'fleet.sock')} ] && echo "own socket"; [ -e ${join(sockets, other, 'fleet.sock')} ] && echo "other socket"; sleep 30`],
      harness: 'claude-code',
    });

    await expect.poll(async () => shown(scout), { timeout: 5000 }).toContain('own socket');
    expect(await shown(scout)).not.toContain('other socket');
  });

  it.runIf(process.platform === 'linux')("lets the socket's caller check find a process of the ship's own container, in the container's own namespaces, and only for that ship (decision 0026)", async () => {
    const [scout, other] = [newId('ship'), newId('ship')];
    mkdirSync(join(sockets, scout), { mode: 0o700 });
    const connections: Socket[] = [];
    const server = createNetServer((connection) => connections.push(connection));
    await new Promise<void>((resolve) => server.listen(join(sockets, scout, 'fleet.sock'), resolve));
    listening.push(server);

    // The test image holds no fleet client: its nc, pointed at the socket, connects as one would.
    await runtime.start({ shipId: scout, folder, command: ['sh', '-c', `sleep 30 | nc -U ${join(sockets, scout, 'fleet.sock')}`], harness: 'claude-code' });

    await expect.poll(() => connections.length, { timeout: 10_000 }).toBeGreaterThan(0);
    const [connection] = connections;
    const mayCall = createCallerCheck({ platform: 'linux', sessionRootOf: (shipId) => runtime.sessionRootOf(shipId) });
    expect({ own: connection && (await mayCall(scout, connection)), other: connection && (await mayCall(other, connection)) }).toEqual({ own: true, other: false });
    for (const each of connections) {
      each.destroy();
    }
  });

  it("makes the ship's home when it has none yet, for its owner alone", async () => {
    const shipId = newId('ship');

    await runtime.start({ shipId, folder, command: ['sleep', '30'], harness: 'claude-code' });

    expect(statSync(join(homes, shipId)).mode & 0o777).toBe(0o700);
  });

  it('caps the memory and the cpus of the container', async () => {
    const shipId = newId('ship');

    await runtime.start({ shipId, folder, command: ['sleep', '30'], harness: 'claude-code' });

    const limits = await runCommand('podman', { args: ['inspect', '--format', '{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}', `trierarch-${shipId}`] });
    expect(limits.stdout.trim()).toBe(`${String(512 * 1024 * 1024)} ${String(1_000_000_000)}`);
  });
});

/** A runner that answers every command as done, saying what it was asked. */
function recordingRunner(answer: (args: readonly string[]) => Partial<CommandResult> = () => ({})) {
  const calls: { command: string; args: readonly string[] }[] = [];
  const run = (command: string, options: { args: readonly string[] }): Promise<CommandResult> => {
    calls.push({ command, args: options.args });
    return Promise.resolve({ status: 0, stdout: '', stderr: '', ...answer(options.args) });
  };
  return { calls, run };
}

// The hold runs a stand-in for the runtime's binary, which writes down the
// words it was run with and runs until it is stopped; what the trierarch runs
// itself (kill, rm, ps, inspect) goes to a recording runner.
describe('the container a session runs in', () => {
  const shipId = newId('ship');
  const image = 'ghcr.io/thomashendrickx/aeolus-session:0.25.0';
  let folder: string;
  let tokenFile: string;
  /** The ships' homes, in a folder of the test's own: the runtime makes a home as it starts a container. */
  let homes: string;
  let sockets: string;
  let sessions: string;
  /** The stand-in for the runtime's binary, as the hold runs it. */
  let binary: string;
  let runtimes: ReturnType<typeof createContainerRuntime>[];

  beforeEach(() => {
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'trierarch-run-')));
    tokenFile = join(folder, 'model-token');
    writeFileSync(tokenFile, `${MODEL_TOKEN}\n`, { mode: 0o600 });
    homes = join(folder, 'homes');
    sockets = join(folder, 'sockets');
    sessions = realpathSync(mkdtempSync('/tmp/aeolus-holds-'));
    binary = join(folder, 'runtime');
    writeFileSync(binary, `#!/bin/sh\nenv > "$0.env"\nfor word in "$@"; do printf '%s\\n' "$word"; done > "$0.words"\nexec sleep 30\n`);
    chmodSync(binary, 0o755);
    runtimes = [];
  });

  afterEach(async () => {
    for (const runtime of runtimes) {
      for (const session of await runtime.list()) {
        await runtime.stop(session.shipId);
      }
    }
    rmSync(folder, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  });

  function runtimeWith(runner: ReturnType<typeof recordingRunner>, options: { launch?: readonly string[] } = {}): ReturnType<typeof createContainerRuntime> {
    const runtime = createContainerRuntime({ binary, image, tokenFile, homes, sockets, sessions, program: TRIERARCH_PROGRAM, version: VERSION, platform: process.platform, ...CAPS, run: runner.run, ...(options.launch !== undefined && { launch: options.launch }) });
    runtimes.push(runtime);
    return runtime;
  }

  /** The words the hold ran the runtime's binary with, once it ran it. */
  async function wordsRun(): Promise<string[]> {
    await expect.poll(() => existsSync(`${binary}.words`)).toBe(true);
    return readFileSync(`${binary}.words`, 'utf8').replace(/\n$/u, '').split('\n');
  }

  async function started(options: { env?: Record<string, string>; readOnly?: readonly string[]; launch?: readonly string[]; proxyToken?: typeof PROXY_TOKEN } = {}) {
    const runner = recordingRunner();
    const runtime = runtimeWith(runner, options.launch === undefined ? {} : { launch: options.launch });
    await runtime.start({
      shipId,
      folder,
      command: ['claude', '--name', 'implementer-b'],
      harness: 'claude-code',
      ...(options.env !== undefined && { env: options.env }),
      ...(options.readOnly !== undefined && { readOnly: options.readOnly }),
      ...(options.proxyToken !== undefined && { proxyToken: options.proxyToken }),
    });
    return { runner, runtime, words: await wordsRun() };
  }

  /** The values a flag of the runtime's own takes: those before the image, not the session command's. */
  const valuesOf = (words: readonly string[], flag: string) => {
    const at = words.indexOf(image);
    const own = at === -1 ? words : words.slice(0, at);
    return own.flatMap((word, index) => (word === flag ? [own[index + 1] ?? ''] : []));
  };
  /** The env file the run names, as it is while the session runs. */
  const envFileOf = (words: readonly string[]): string => valuesOf(words, '--env-file')[0] ?? '';

  it('runs the configured binary from the hold, attached, kept in and removed once it ends (H18)', async () => {
    const { words } = await started();

    expect({ run: words[0], isRemoved: words.includes('--rm'), isInteractive: words.includes('-i'), isDetached: words.includes('--detach') }).toEqual({ run: 'run', isRemoved: true, isInteractive: true, isDetached: false });
  });

  it("runs one container per ship, named after its ship id, from the image, with the session's command after it", async () => {
    const { words } = await started();

    expect({ name: valuesOf(words, '--name'), tail: words.slice(words.indexOf(image)) }).toEqual({ name: [`trierarch-${shipId}`], tail: [image, 'claude', '--name', 'implementer-b'] });
  });

  it("removes the ship's container before it runs a new one, so an exited one is replaced", async () => {
    const { runner } = await started();

    expect(runner.calls.filter((call) => call.args.includes(`trierarch-${shipId}`)).map((call) => call.args[0])).toEqual(['kill', 'rm']);
  });

  it('caps the memory, the swap with it, the cpus and the processes as configured', async () => {
    const { words } = await started();

    expect({ memory: valuesOf(words, '--memory'), swap: valuesOf(words, '--memory-swap'), cpus: valuesOf(words, '--cpus'), pids: valuesOf(words, '--pids-limit') }).toEqual({ memory: ['512m'], swap: ['512m'], cpus: ['1'], pids: ['4096'] });
  });

  it('runs as the session user with the flags a nested rootless Podman needs', async () => {
    const { words } = await started();

    expect(words).toEqual(expect.arrayContaining(['--userns=keep-id:uid=1000,gid=1000', '--device', '/dev/fuse', '--device', '/dev/net/tun', '--cap-add', 'SYS_ADMIN', '--security-opt', 'unmask=ALL']));
  });

  it("mounts only the session's folder, at its own path, its ship's own home as the container's home, and its ship's socket folder at its own path, so never the runtime's socket", async () => {
    const { words } = await started();

    expect({ volumes: valuesOf(words, '--volume'), workdir: valuesOf(words, '--workdir'), home: valuesOf(words, '--env'), others: words.filter((word) => word.startsWith('-v') || word.startsWith('--mount')) }).toEqual({
      volumes: [`${folder}:${folder}`, `${homes}/${shipId}:/home/ubuntu`, `${sockets}/${shipId}:${sockets}/${shipId}`],
      workdir: [folder],
      home: ['HOME=/home/ubuntu'],
      others: [],
    });
  });

  it("mounts each of the session's read-only checkouts at its own path, read-only, so the session can change nothing in it (#1182)", async () => {
    const governance = `/home/thomas/.aeolus/trierarch/checkouts/${shipId}/governance`;

    const { words } = await started({ readOnly: [governance] });

    expect(valuesOf(words, '--volume')).toContain(`${governance}:${governance}:ro`);
  });

  it('gives the container no restart policy: the trierarch starts a dead one again itself', async () => {
    const { words } = await started();

    expect(words.filter((word) => word.startsWith('--restart'))).toEqual([]);
  });

  it("hands the model token and the session's environment through an env file in the session's own folder, for its owner alone, never on a command line (#445)", async () => {
    const { words } = await started({ env: { AEOLUS_LAUNCH: 'launch-1' } });

    const envFile = envFileOf(words);
    expect({
      folder: envFile.startsWith(join(sessions, shipId)),
      content: readFileSync(envFile, 'utf8'),
      mode: statSync(envFile).mode & 0o777,
      onCommandLine: words.some((word) => word.includes(MODEL_TOKEN) || word.includes('launch-1')),
    }).toEqual({ folder: true, content: `AEOLUS_LAUNCH=launch-1\n${MODEL_TOKEN_VARIABLE}=${MODEL_TOKEN}\n`, mode: 0o600, onCommandLine: false });
  });

  it('keeps the env file while the session runs, so the hold can run its container again, and removes it once the session stops', async () => {
    const { runtime, words } = await started();
    const envFile = envFileOf(words);
    expect(existsSync(envFile)).toBe(true);

    await runtime.stop(shipId);

    expect(existsSync(envFile)).toBe(false);
  });

  it("hands a session on an API key its proxy token by its variable's name alone, the value in the environment its hold runs the container with, never on a command line or in the env file (api keys K7)", async () => {
    const { words } = await started({ proxyToken: PROXY_TOKEN });

    expect({
      named: valuesOf(words, '--env'),
      inHoldEnvironment: readFileSync(`${binary}.env`, 'utf8').includes(`${PROXY_TOKEN.variable}=${PROXY_TOKEN.token}\n`),
      onCommandLine: words.some((word) => word.includes(PROXY_TOKEN.token)),
      inEnvFile: readFileSync(envFileOf(words), 'utf8').includes(PROXY_TOKEN.token),
    }).toEqual({ named: ['HOME=/home/ubuntu', PROXY_TOKEN.variable], inHoldEnvironment: true, onCommandLine: false, inEnvFile: false });
  });

  it("gives a session on an API key no model token: the model token is the subscription's login (headless H15)", async () => {
    const { words } = await started({ proxyToken: PROXY_TOKEN, env: { AEOLUS_LAUNCH: 'launch-1' } });

    expect(readFileSync(envFileOf(words), 'utf8')).toBe('AEOLUS_LAUNCH=launch-1\n');
  });

  it("lets a session on an API key reach the host's loopback, where the model proxy listens, at Podman's host address (headless H16)", async () => {
    const { words } = await started({ proxyToken: PROXY_TOKEN });

    expect(valuesOf(words, '--network')).toEqual(['slirp4netns:allow_host_loopback=true']);
  });

  it("keeps a session on its subscription off the host's loopback", async () => {
    const { words } = await started();

    expect(valuesOf(words, '--network')).toEqual([]);
  });

  it('refuses an environment value of more than one line, which an env file cannot hold', async () => {
    const runner = recordingRunner();

    await expect(runtimeWith(runner).start({ shipId, folder, command: ['claude'], env: { AEOLUS_LAUNCH: 'one\ntwo' }, harness: 'claude-code' })).rejects.toThrow('AEOLUS_LAUNCH');
  });

  it("starts the hold through the launch command, so under a systemd unit the container's run lives outside the service's control group (#479, #537)", async () => {
    const launcher = join(folder, 'launcher');
    writeFileSync(launcher, `#!/bin/sh\ntouch "$0.used"\nexec "$@"\n`);
    chmodSync(launcher, 0o755);

    await started({ launch: [launcher] });

    expect(existsSync(`${launcher}.used`)).toBe(true);
  });

  it("names the container's first process, as the host sees it, as the root of the ship's session", async () => {
    const runner = recordingRunner((args) => (args[0] === 'inspect' ? { stdout: '4242\n' } : {}));

    await expect(runtimeWith(runner).sessionRootOf(shipId)).resolves.toBe(4242);
    expect(runner.calls.at(-1)?.args).toEqual(['inspect', '--format', '{{.State.Pid}}', `trierarch-${shipId}`]);
  });

  it.each([
    { label: 'no container', answer: { status: 125, stdout: '' } },
    { label: 'a container that runs no more', answer: { stdout: '0\n' } },
  ])('names no root for $label', async ({ answer }) => {
    const runner = recordingRunner((args) => (args[0] === 'inspect' ? answer : {}));

    await expect(runtimeWith(runner).sessionRootOf(shipId)).resolves.toBeUndefined();
  });

  it("lists a session under its hold once, and of this trierarch's other containers, which an older one started detached, each as of another version", async () => {
    const [older, exited] = [newId('ship'), newId('ship')];
    const runner = recordingRunner((args) => (args[0] === 'ps' ? { stdout: `trierarch-${shipId} running\ntrierarch-${older} running\ntrierarch-${exited} exited\nsomeone-else running\n` } : {}));
    const runtime = runtimeWith(runner);
    await runtime.start({ shipId, folder, command: ['claude'], harness: 'claude-code' });

    const listed = await runtime.list();

    expect({ listed, filter: valuesOf(runner.calls.find((call) => call.args[0] === 'ps')?.args ?? [], '--filter') }).toEqual({
      listed: [
        { shipId, status: 'running' },
        { shipId: older, status: 'running', isOtherVersion: true },
        { shipId: exited, status: 'exited', isOtherVersion: true },
      ],
      filter: ['label=aeolus.trierarch=aeolus-trierarch'],
    });
  });

  it('stops a session: its container is killed and removed, and its hold ends', async () => {
    const { runner, runtime } = await started();
    const hold = holdPidOf(sessions, shipId);
    runner.calls.splice(0);

    await runtime.stop(shipId);

    expect({ calls: runner.calls.filter((call) => call.args.includes(`trierarch-${shipId}`)).map((call) => call.args[0]), isHoldRunning: (() => {
      try {
        process.kill(hold, 0);
        return true;
      } catch {
        return false;
      }
    })() }).toEqual({ calls: ['kill', 'rm'], isHoldRunning: false });
  });
});
