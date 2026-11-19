import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { runCommand } from '../src/adapters/run-command.js';

it('clears nested test containers and volumes before a ship session starts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ship-init-'));
  try {
    const podman = join(home, 'podman');
    await writeFile(podman, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/calls"\n');
    await chmod(podman, 0o755);
    const result = await runCommand('bash', { args: [fileURLToPath(new URL('../image/session-init.sh', import.meta.url)), 'true'], env: { HOME: home, PATH: `${home}:/usr/bin:/bin`, AEOLUS_SHIP_CONTAINER_STORAGE: '1' } });
    expect(result.status).toBe(0);
    const calls = await readFile(join(home, 'calls'), 'utf8');
    expect(calls).toContain('rm --all --force --volumes');
    expect(calls).toContain('volume rm --all --force');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
