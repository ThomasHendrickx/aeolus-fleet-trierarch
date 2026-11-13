import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TrierarchConfiguration } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TRIERARCH_PROGRAM } from '../../test/support/hold-program.js';
import { newId, inRepositories } from '../../test/support/in-memory.js';
import { trierarchPaths, type TrierarchPaths } from './paths.js';
import { runCommand } from './run-command.js';
import { runtimeAdaptersOf } from './runtime-adapters.js';

const MODEL_TOKEN = 'sk-ant-oat01-test-token';
const CONTAINER = { kind: 'container', binary: '', memory: '4g', cpus: 2 } as const;

let home: string;
let paths: TrierarchPaths;
let repository: string;
/** A docker-style binary that logs each call's arguments, and the env file a run passes, and lists one running container, as an older trierarch left it, until it is removed. */
let binary: string;
let shipId: ReturnType<typeof newId<'ship'>>;

async function git(args: readonly string[]): Promise<void> {
  const result = await runCommand('git', { args, env: { GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' } });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
}

beforeEach(async () => {
  // Short, under /tmp: a hold's socket sits in the trierarch's files under it, and a Unix socket path is at most 104 bytes on macOS.
  home = realpathSync(mkdtempSync('/tmp/aeolus-adapters-'));
  paths = trierarchPaths({ homeDirectory: home });
  repository = join(home, 'demo');
  await git(['init', '-q', '-b', 'main', repository]);
  writeFileSync(join(repository, 'README.md'), 'demo\n');
  await git(['-C', repository, 'add', '.']);
  await git(['-C', repository, 'commit', '-q', '-m', 'init']);
  shipId = newId('ship');
  binary = join(home, 'runtime');
  writeFileSync(
    binary,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${join(home, 'calls')}'`,
      'previous=""',
      `for argument; do [ "$previous" = --env-file ] && cat "$argument" >> '${join(home, 'env')}'; previous=$argument; done`,
      // Its container is listed until removed, and again once run.
      `[ "$1" = rm ] && touch '${join(home, 'removed')}'`,
      `[ "$1" = run ] && rm -f '${join(home, 'removed')}'`,
      `[ "$1" = ps ] && [ ! -e '${join(home, 'removed')}' ] && echo 'trierarch-${shipId} running'`,
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(binary, 0o755);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function configuration(runtime?: TrierarchConfiguration['runtime']): TrierarchConfiguration {
  return { caps: { ships: 2, running: 2 }, repositories: { demo: { path: repository } }, folders: {}, harnesses: { 'claude-code': { flags: [], options: {} } }, ...(runtime !== undefined && { runtime }) };
}

function adaptersOf(runtime?: TrierarchConfiguration['runtime'], shipsRoot?: string) {
  return runtimeAdaptersOf({ configuration: { ...configuration(runtime), ...(shipsRoot !== undefined && { shipsRoot }) }, paths, version: '0.25.0', launch: [], managedSettings: join(home, 'managed'), proxyUrl: () => Promise.resolve(undefined), program: TRIERARCH_PROGRAM });
}

describe('the adapters the session runtime picks (decision 0039)', () => {
  it('gives sessions on the host a worktree and the host home', async () => {
    const adapters = adaptersOf();

    const { folder } = await adapters.workspace.prepare({ shipId, shipName: 'scout', workspace: inRepositories('demo'), shipFolder: await adapters.workspace.shipFolderOf(shipId) });

    expect({ isWorktree: statSync(join(folder, 'main', '.git')).isFile(), shipHomes: adapters.shipHomes }).toEqual({ isWorktree: true, shipHomes: undefined });
  });

  it('gives sessions in containers a clone of their own, at the same path', async () => {
    const { workspace } = adaptersOf({ ...CONTAINER, binary });
    const { folder } = await workspace.prepare({ shipId, shipName: 'scout', workspace: inRepositories('demo'), shipFolder: await workspace.shipFolderOf(shipId) });

    expect({ folder, isClone: statSync(join(folder, 'main', '.git')).isDirectory() }).toEqual({ folder: join(paths.ships, shipId, 'repositories'), isClone: true });
  });

  it('gives sessions in containers their folder by its real path, as the aeolus-fleet plugin in the container and on the host both key it (pwd -P), through a worktree root that is a link', async () => {
    mkdirSync(join(home, 'real-root'));
    symlinkSync(join(home, 'real-root'), join(home, 'linked-root'));

    const { workspace } = adaptersOf({ ...CONTAINER, binary }, join(home, 'linked-root'));
    const { folder } = await workspace.prepare({ shipId, shipName: 'scout', workspace: inRepositories('demo'), shipFolder: await workspace.shipFolderOf(shipId) });

    expect(folder).toBe(join(home, 'real-root', shipId, 'repositories'));
  });

  it("gives a ship crewed fresh its ship's folder under ships/ when the configuration names no place, its ship folder in it", async () => {
    const adapters = adaptersOf();
    const shipFolder = await adapters.workspace.shipFolderOf(shipId);

    const { folder } = await adapters.workspace.prepare({ shipId, shipName: 'scout', workspace: inRepositories('demo'), shipFolder });

    expect([shipFolder, folder]).toEqual([join(paths.ships, shipId), join(paths.ships, shipId, 'repositories')]);
  });

  it("gives a ship crewed fresh in containers its ship's folder by its real path, through a place of ships/ that is a link", async () => {
    mkdirSync(join(home, 'real-ships'));
    symlinkSync(join(home, 'real-ships'), join(home, 'linked-ships'));

    await expect(adaptersOf({ ...CONTAINER, binary }, join(home, 'linked-ships')).workspace.shipFolderOf(shipId)).resolves.toBe(join(home, 'real-ships', shipId));
  });

  it.each([{ runtime: 'the host' }, { runtime: 'containers' }])("empties the trash beside the place of ships/, and beside each repository's folder under the old worktree root, on $runtime", async ({ runtime }) => {
    const trashed = [join(paths.ships, '.trash', `${shipId}.1793707200000`), join(paths.worktrees, 'demo', '.trash', 'scout.1793707200000')];
    for (const folder of trashed) {
      mkdirSync(folder, { recursive: true });
    }

    await (runtime === 'the host' ? adaptersOf() : adaptersOf({ ...CONTAINER, binary })).trash.empty();

    expect(trashed.filter((folder) => existsSync(folder))).toEqual([]);
  });

  it('stops the processes in a folder on the host, and in containers leaves a folder a container works in', async () => {
    const empty = join(home, 'empty');
    mkdirSync(empty);

    expect({ host: await adaptersOf().folderProcesses.stopIn(empty), container: await adaptersOf({ ...CONTAINER, binary }).folderProcesses.stopIn(empty).catch((error: unknown) => String(error)) }).toEqual({
      host: 0,
      container: `Error: A container works in ${empty}, so it is left for the next pass: trierarch-${shipId}`,
    });
  });

  it("gives sessions in containers a home of each ship's own under the trierarch's homes", () => {
    const shipHomes = adaptersOf({ ...CONTAINER, binary }).shipHomes;

    expect({ homes: shipHomes?.homes, managedSettings: shipHomes?.managedSettings, isMovedWithinUserNamespace: typeof shipHomes?.moveWithinUserNamespace === 'function' }).toEqual({ homes: paths.homes, managedSettings: join(home, 'managed'), isMovedWithinUserNamespace: true });
  });

  it('has sessions on the host and in containers reach the model proxy where the trierarch does, a container on its own loopback (headless H16)', () => {
    expect({ host: adaptersOf().modelProxyUrlOf('http://127.0.0.1:4100'), container: adaptersOf({ ...CONTAINER, binary }).modelProxyUrlOf('http://127.0.0.1:4100') }).toEqual({ host: 'http://127.0.0.1:4100', container: 'http://127.0.0.1:4100' });
  });

  it('lists the sessions through the binary the configuration names', async () => {
    await expect(adaptersOf({ ...CONTAINER, binary }).sessions.list()).resolves.toEqual([{ shipId, status: 'running', isOtherVersion: true }]);
  });

  it("starts a session from the image of the trierarch's own version, with the configured caps and the machine's model token", async () => {
    mkdirSync(paths.home, { recursive: true });
    writeFileSync(paths.modelToken, `${MODEL_TOKEN}\n`, { mode: 0o600 });

    await adaptersOf({ ...CONTAINER, binary }).sessions.start({ shipId, folder: repository, command: ['claude'], harness: 'claude-code' });

    await expect.poll(() => readFileSync(join(home, 'calls'), 'utf8')).toContain('run ');
    const run = readFileSync(join(home, 'calls'), 'utf8').split('\n').find((call) => call.startsWith('run '));
    expect({
      image: run?.includes(' ghcr.io/thomashendrickx/aeolus-session:0.25.0 '),
      caps: run?.includes('--memory 4g --cpus 2'),
      token: readFileSync(join(home, 'env'), 'utf8').includes(MODEL_TOKEN),
    }).toEqual({ image: true, caps: true, token: true });
  });
});
