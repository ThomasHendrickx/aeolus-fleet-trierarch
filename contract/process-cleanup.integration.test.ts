import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, inject, it } from 'vitest';
import { z } from 'zod';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VITEST = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const CONFIG = join(ROOT, 'contract', 'fixtures', 'process-cleanup', 'vitest.config.ts');

function isRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

it.each(['success', 'failure', 'timeout'])('leaves no fleet, service or proxy process after a test %s', async (ending) => {
  const folder = mkdtempSync(join(tmpdir(), 'process-cleanup-'));
  const pidsFile = join(folder, 'pids');
  const child = spawn(process.execPath, [VITEST, 'run', '--config', CONFIG], {
    cwd: ROOT,
    env: { ...process.env, PROCESS_CLEANUP_POSTGRES_URL: inject('postgresUrl'), PROCESS_CLEANUP_PIDS: pidsFile, PROCESS_CLEANUP_ENDING: ending, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const exited = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  const pids = existsSync(pidsFile) ? z.tuple([z.number(), z.number(), z.number()]).parse(JSON.parse(readFileSync(pidsFile, 'utf8'))) : [];
  try {
    expect(exited, output).toBe(ending === 'success' ? 0 : 1);
    expect(pids, output).toHaveLength(3);
    expect(pids.filter(isRunning), output).toEqual([]);
  } finally {
    for (const pid of pids) if (isRunning(pid)) process.kill(pid, 'SIGKILL');
    rmSync(folder, { recursive: true, force: true });
  }
}, 180_000);
