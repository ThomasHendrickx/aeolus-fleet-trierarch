import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { TRIERARCH_PROGRAM } from '../../test/support/hold-program.js';
import { newId } from '../../test/support/in-memory.js';
import { aShortHome } from '../../test/support/short-home.js';
import { createContainerRuntime } from './container.js';

it('keeps nested Podman storage and runtime files in the ship folder', async () => {
  const folder = realpathSync(aShortHome('nested-storage'));
  const sessions = realpathSync(aShortHome('nested-holds'));
  const shipId = newId('ship');
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
    const nested = '/home/ubuntu/.local/share/containers/storage';
    expect(env).toContain(`CONTAINERS_CONF=${nested}/containers.conf`);
    expect(env).toContain(`CONTAINERS_STORAGE_CONF=${nested}/storage.conf`);
    expect(env).toContain(`XDG_RUNTIME_DIR=${nested}/runtime`);
    expect(readFileSync(join(shipFolder, 'containers', 'containers.conf'), 'utf8')).toContain(`tmp_dir = "${nested}/tmp"`);
    expect(readFileSync(join(shipFolder, 'containers', 'storage.conf'), 'utf8')).toContain(`rootless_storage_path = "${nested}/graph"`);
  } finally {
    await runtime.stop(shipId);
    rmSync(folder, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  }
});
