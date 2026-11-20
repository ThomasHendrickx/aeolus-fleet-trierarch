import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, inject, it } from 'vitest';
import { z } from 'zod';

import { PROCESS_RECORD_VARIABLE } from '../scripts/support/test-process.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VITEST = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const CONFIG = join(ROOT, 'contract', 'fixtures', 'process-cleanup', 'vitest.config.ts');

const processSchema = z.object({ pid: z.number().int().gt(1), start: z.string().min(1) });
type RecordedProcess = z.infer<typeof processSchema>;

function isRunning(recorded: RecordedProcess): boolean {
  try {
    const stat = readFileSync(`/proc/${String(recorded.pid)}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[0] !== 'Z' && fields[19] === recorded.start;
  } catch { return false; }
}

/** The processes a run recorded for the leftovers check, by their PIDs. */
function recordedIn(record: string): Set<number> {
  return new Set(existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean).map((line) => Number(line.split(' ')[0])) : []);
}

it.each(['success', 'failure', 'timeout'])('leaves no fleet, service or proxy process after a test %s', async (ending) => {
  const folder = mkdtempSync(join(tmpdir(), 'process-cleanup-'));
  const pidsFile = join(folder, 'pids');
  const record = join(folder, 'process-record');
  const child = spawn(process.execPath, [VITEST, 'run', '--config', CONFIG], {
    cwd: ROOT,
    env: { ...process.env, PROCESS_CLEANUP_POSTGRES_URL: inject('postgresUrl'), PROCESS_CLEANUP_PIDS: pidsFile, PROCESS_CLEANUP_ENDING: ending, [PROCESS_RECORD_VARIABLE]: record, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const exited = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  const { started, descendants } = existsSync(pidsFile) ? z.object({ started: z.array(processSchema), descendants: z.array(processSchema) }).parse(JSON.parse(readFileSync(pidsFile, 'utf8'))) : { started: [], descendants: [] };
  const pids = [...started, ...descendants];
  try {
    expect(exited, output).toBe(ending === 'success' ? 0 : 1);
    expect(started.length, output).toBeGreaterThanOrEqual(4);
    expect(pids.filter(isRunning), output).toEqual([]);
    expect(started.filter(({ pid }) => !recordedIn(record).has(pid)), output).toEqual([]);
  } finally {
    for (const recorded of pids) if (isRunning(recorded)) process.kill(recorded.pid, 'SIGKILL');
    rmSync(folder, { recursive: true, force: true });
  }
}, 180_000);


it.each(['failure', 'timeout'])('leaves no plugin command or fleet worker after a test %s', async (ending) => {
  const folder = mkdtempSync(join(tmpdir(), 'plugin-process-cleanup-'));
  const pidsFile = join(folder, 'pids');
  const config = join(ROOT, 'contract', 'fixtures', 'process-cleanup', 'plugin-vitest.config.ts');
  const child = spawn(process.execPath, [VITEST, 'run', '--config', config, '-t', 'plugin process cleanup fixture'], {
    cwd: ROOT,
    env: { ...process.env, PROCESS_CLEANUP_POSTGRES_URL: inject('postgresUrl'), PROCESS_CLEANUP_PIDS: pidsFile, PROCESS_CLEANUP_ENDING: ending, PROCESS_CLEANUP_PLUGIN: '1', PROCESS_CLEANUP_CHILD: join(folder, 'child'), NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const exited = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  const pids = existsSync(pidsFile) ? z.tuple([processSchema, processSchema, processSchema]).parse(JSON.parse(readFileSync(pidsFile, 'utf8'))) : [];
  try {
    expect(exited, output).toBe(1);
    expect(pids, output).toHaveLength(3);
    expect(pids.filter(isRunning), output).toEqual([]);
  } finally {
    for (const recorded of pids) if (isRunning(recorded)) process.kill(recorded.pid, 'SIGKILL');
    rmSync(folder, { recursive: true, force: true });
  }
}, 180_000);


it('closes the plugin fleet when setup fails before the door starts', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'plugin-setup-cleanup-'));
  const stateFile = join(folder, 'state');
  const config = join(ROOT, 'contract', 'fixtures', 'process-cleanup', 'plugin-vitest.config.ts');
  const child = spawn(process.execPath, [VITEST, 'run', '--config', config, '-t', 'plugin process cleanup fixture'], {
    cwd: ROOT,
    env: { ...process.env, PROCESS_CLEANUP_POSTGRES_URL: inject('postgresUrl'), PROCESS_CLEANUP_PIDS: stateFile, PROCESS_CLEANUP_PLUGIN: '1', PROCESS_CLEANUP_SETUP: '1', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const exited = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  try {
    expect(exited, output).toBe(1);
    expect(existsSync(stateFile), output).toBe(true);
    expect(readFileSync(stateFile, 'utf8'), output).toBe('false');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}, 180_000);


it.each(['ignore', 'exit', 'interrupt', 'external'])('stops a machine command and its child in %s mode', async (ending) => {
  const folder = mkdtempSync(join(tmpdir(), 'command-cleanup-'));
  const pidsFile = join(folder, 'pids');
  const config = join(ROOT, 'contract', 'fixtures', 'process-cleanup', 'command-vitest.config.ts');
  const program = join(ROOT, 'contract', 'fixtures', 'process-cleanup', 'ignores-interrupt.sh');
  const child = spawn(process.execPath, [VITEST, 'run', '--config', config], {
    cwd: ROOT,
    env: { ...process.env, AEOLUS_TRIERARCH_UNDER_TEST: program, PROCESS_CLEANUP_PIDS: pidsFile, PROCESS_CLEANUP_ENDING: ending, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const exited = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  const pids = existsSync(pidsFile) ? z.tuple([processSchema, processSchema, processSchema]).parse(JSON.parse(readFileSync(pidsFile, 'utf8'))) : [];
  try {
    expect(exited, output).toBe(1);
    expect(pids, output).toHaveLength(3);
    expect(pids.filter(isRunning), output).toEqual([]);
  } finally {
    for (const recorded of pids) if (isRunning(recorded)) process.kill(recorded.pid, 'SIGKILL');
    rmSync(folder, { recursive: true, force: true });
  }
}, 60_000);
