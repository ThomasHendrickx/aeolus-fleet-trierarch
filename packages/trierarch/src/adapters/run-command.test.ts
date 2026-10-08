import { describe, expect, it } from 'vitest';

import { runCommand } from './run-command.js';

describe('running a program', () => {
  it('ends a program that runs past its time limit, answering it as failed (#365)', async () => {
    const started = Date.now();

    const result = await runCommand('sh', { args: ['-c', 'sleep 5'], timeoutMs: 100 });

    expect(result.status).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('answers at its time limit though the program leaves a child holding its output open (#365)', async () => {
    const started = Date.now();

    // The shell forks sleep, which keeps the output open after the shell is ended.
    const result = await runCommand('sh', { args: ['-c', 'sleep 5; echo done'], timeoutMs: 100 });

    expect(result.status).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
