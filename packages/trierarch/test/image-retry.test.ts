import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const retry = join(import.meta.dirname, '../image/retry.sh');
const containerfile = join(import.meta.dirname, '../image/Containerfile');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'image-retry-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// A command that fails its first `failures` runs, as an outage that ends does.
const flaky = (failures: number): string[] => {
  const counter = join(dir, 'count');
  writeFileSync(counter, '0');
  const script = join(dir, 'flaky.sh');
  writeFileSync(
    script,
    `n=$(( $(cat ${counter}) + 1 )); echo $n > ${counter}; [ $n -gt ${failures} ]`,
  );
  return ['bash', script];
};
const runs = (): number => Number(readFileSync(join(dir, 'count'), 'utf8'));
const run = (attempts: number, cmd: string[]) =>
  spawnSync('bash', [retry, String(attempts), '0', ...cmd], { encoding: 'utf8' });

describe('the session image retry step', () => {
  it('runs a command that works once', () => {
    const result = run(3, flaky(0));
    expect(result.status).toBe(0);
    expect(runs()).toBe(1);
  });

  it('retries a command that fails during a short outage until it works', () => {
    const result = run(5, flaky(2));
    expect(result.status).toBe(0);
    expect(runs()).toBe(3);
  });

  it('gives up after the bounded attempts with the failing exit code', () => {
    const result = run(3, ['bash', '-c', 'exit 100']);
    expect(result.status).toBe(100);
    const flakyForever = run(3, flaky(99));
    expect(flakyForever.status).not.toBe(0);
    expect(runs()).toBe(3);
  });

  it('is used by the Containerfile for every step that reaches the network', () => {
    const text = readFileSync(containerfile, 'utf8');
    expect(text).toContain('/usr/local/bin/aeolus-retry apt-get update');
    expect(text).toContain('aeolus-retry apt-get install');
    expect(text).toMatch(/aeolus-retry bash -c 'curl[^']*nodesource/);
  });
});
