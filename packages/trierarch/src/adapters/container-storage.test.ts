import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { TRIERARCH_PROGRAM } from '../../test/support/hold-program.js';
import { newId } from '../../test/support/in-memory.js';
import { aShortHome } from '../../test/support/short-home.js';
import { createContainerRuntime } from './container.js';
import { shipPodmanRuntime } from './paths.js';

it('keeps nested Podman storage with the ship and runtime in the user runtime directory', async () => {
  const folder = realpathSync(aShortHome('nested-storage'));
  const sessions = realpathSync(aShortHome('nested-holds'));
  const shipId = newId('ship');
  const runtimeRoot = realpathSync(aShortHome('nested-runtime'));
  const shipRuntime = shipPodmanRuntime(runtimeRoot, shipId);
  const previous = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtimeRoot;
  const shipFolder = join(folder, 'ships', shipId);
  const binary = join(folder, 'runtime');
  const tokenFile = join(folder, 'token');
  writeFileSync(tokenFile, 'token');
  writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$@" > "$0.words"\nexec sleep 30\n');
  chmodSync(binary, 0o755);
  mkdirSync(shipFolder, { recursive: true });
  const runtime = createContainerRuntime({
    binary, image: 'test-image', tokenFile, homes: join(folder, 'homes'), sockets: join(folder, 'sockets'),
    sessions, program: TRIERARCH_PROGRAM, version: 'test', platform: 'linux', memory: '512m', cpus: 1,
    proxyUrl: () => Promise.resolve(undefined),
    run: () => Promise.resolve({ status: 0, stdout: '', stderr: '' }),
  });
  try {
    await runtime.start({ shipId, shipFolder, folder, command: ['claude'], harness: 'claude-code' });
    await expect.poll(() => existsSync(`${binary}.words`)).toBe(true);
    const words = readFileSync(`${binary}.words`, 'utf8').split('\n');
    const envFile = words[words.indexOf('--env-file') + 1] ?? '';
    const env = readFileSync(envFile, 'utf8');
    const nested = '/containers';
    expect(env).toContain(`CONTAINERS_CONF=${nested}/containers.conf`);
    expect(env).toContain(`CONTAINERS_STORAGE_CONF=${nested}/storage.conf`);
    expect(env).toContain('XDG_RUNTIME_DIR=/containers-runtime');
    expect(words).toContain(`${shipRuntime}:/containers-runtime`);
    expect(readFileSync(join(shipFolder, 'containers', 'containers.conf'), 'utf8')).toContain('tmp_dir = "/containers-runtime/tmp"');
    expect(readFileSync(join(shipFolder, 'containers', 'storage.conf'), 'utf8')).toContain(`rootless_storage_path = "${nested}/graph"`);
  } finally {
    await runtime.stop(shipId);
    expect(existsSync(shipRuntime)).toBe(false);
    if (previous === undefined) Reflect.deleteProperty(process.env, 'XDG_RUNTIME_DIR');
    else process.env.XDG_RUNTIME_DIR = previous;
    rmSync(runtimeRoot, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  }
});

it('starts a container session without Podman when its runtime directory cannot be used', async () => {
  const folder = realpathSync(aShortHome('nested-storage'));
  const sessions = realpathSync(aShortHome('nested-holds'));
  const shipId = newId('ship');
  const shipFolder = join(folder, 'ships', shipId);
  const binary = join(folder, 'runtime');
  const tokenFile = join(folder, 'token');
  const invalid = join(folder, 'not-a-directory');
  writeFileSync(tokenFile, 'token');
  writeFileSync(invalid, 'file');
  writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$@" > "$0.words"\nexec sleep 30\n');
  chmodSync(binary, 0o755);
  mkdirSync(shipFolder, { recursive: true });
  const runtime = createContainerRuntime({
    binary, image: 'test-image', tokenFile, homes: join(folder, 'homes'), sockets: join(folder, 'sockets'),
    sessions, program: TRIERARCH_PROGRAM, version: 'test', platform: 'linux', memory: '512m', cpus: 1,
    proxyUrl: () => Promise.resolve(undefined),
    run: () => Promise.resolve({ status: 0, stdout: '', stderr: '' }),
  });
  const previous = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = invalid;
  try {
    await runtime.start({ shipId, shipFolder, folder, command: ['claude'], harness: 'claude-code' });
    await expect.poll(() => existsSync(`${binary}.words`)).toBe(true);
    expect(readFileSync(join(sessions, shipId, 'events.jsonl'), 'utf8')).toContain('Nested Podman cannot start');
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'XDG_RUNTIME_DIR');
    else process.env.XDG_RUNTIME_DIR = previous;
    await runtime.stop(shipId);
    rmSync(folder, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  }
});
