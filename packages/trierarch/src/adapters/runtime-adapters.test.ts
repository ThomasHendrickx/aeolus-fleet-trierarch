import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TrierarchConfiguration } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../../test/support/in-memory.js';
import { trierarchPaths, type TrierarchPaths } from './paths.js';
import { runCommand } from './run-command.js';
import { runtimeAdaptersOf } from './runtime-adapters.js';

const MODEL_TOKEN = 'sk-ant-oat01-test-token';
const CONTAINER = { kind: 'container', binary: '', memory: '4g', cpus: 2 } as const;

let home: string;
let paths: TrierarchPaths;
let repository: string;
/** A docker-style binary that logs each call's arguments, and the env file a run passes, and lists one running container. */
let binary: string;
let shipId: ReturnType<typeof newId<'ship'>>;

async function git(args: readonly string[]): Promise<void> {
  const result = await runCommand('git', { args, env: { GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' } });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
}

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'trierarch-runtime-adapters-')));
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
      `[ "$1" = ps ] && echo 'trierarch-${shipId} running'`,
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

function adaptersOf(runtime?: TrierarchConfiguration['runtime']) {
  return runtimeAdaptersOf({ configuration: configuration(runtime), paths, version: '0.25.0', launch: [], managedSettings: join(home, 'managed') });
}

describe('the adapters the session runtime picks (decision 0039)', () => {
  it('gives sessions on the host a worktree and the host home', async () => {
    const adapters = adaptersOf();

    const { folder } = await adapters.workspace.prepare({ shipId, shipName: 'scout', workspace: { kind: 'worktree', repository: 'demo' } });

    expect({ isWorktree: statSync(join(folder, '.git')).isFile(), shipHomes: adapters.shipHomes }).toEqual({ isWorktree: true, shipHomes: undefined });
  });

  it('gives sessions in containers a clone of their own, at the same path', async () => {
    const { folder } = await adaptersOf({ ...CONTAINER, binary }).workspace.prepare({ shipId, shipName: 'scout', workspace: { kind: 'worktree', repository: 'demo' } });

    expect({ folder, isClone: statSync(join(folder, '.git')).isDirectory() }).toEqual({ folder: join(paths.worktrees, 'demo', 'scout'), isClone: true });
  });

  it("gives sessions in containers a home of each ship's own under the trierarch's homes", () => {
    expect(adaptersOf({ ...CONTAINER, binary }).shipHomes).toEqual({ homes: paths.homes, managedSettings: join(home, 'managed') });
  });

  it('lists the sessions through the binary the configuration names', async () => {
    await expect(adaptersOf({ ...CONTAINER, binary }).sessions.list()).resolves.toEqual([{ shipId, status: 'running' }]);
  });

  it("starts a session from the image of the trierarch's own version, with the configured caps and the machine's model token", async () => {
    mkdirSync(paths.home, { recursive: true });
    writeFileSync(paths.modelToken, `${MODEL_TOKEN}\n`, { mode: 0o600 });

    await adaptersOf({ ...CONTAINER, binary }).sessions.start({ shipId, folder: repository, command: ['claude'] });

    const run = readFileSync(join(home, 'calls'), 'utf8').split('\n').find((call) => call.startsWith('run '));
    expect({
      image: run?.includes(' ghcr.io/thomashendrickx/aeolus-session:0.25.0 '),
      caps: run?.includes('--memory 4g --cpus 2'),
      token: readFileSync(join(home, 'env'), 'utf8').includes(MODEL_TOKEN),
    }).toEqual({ image: true, caps: true, token: true });
  });
});
