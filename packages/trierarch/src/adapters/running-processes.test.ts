import { describe, expect, it } from 'vitest';

import { processesOf } from './running-processes.js';

const NOW = new Date('2026-10-11T12:00:00Z');

describe('the running processes, as ps says them', () => {
  it('reads the pid, the program and when it started from minutes and seconds', () => {
    expect(processesOf(' 4242   05:07 codex\n', NOW)).toEqual([{ pid: 4242, program: 'codex', startedAt: new Date('2026-10-11T11:54:53Z') }]);
  });

  it('reads hours and days as they elapsed', () => {
    expect(processesOf('17 2-03:04:05 codex\n', NOW).map((process) => process.startedAt)).toEqual([new Date('2026-10-09T08:55:55Z')]);
  });

  it('keeps a program path with spaces whole', () => {
    expect(processesOf('9 01:00 /Applications/ChatGPT.app/Contents/Resources/codex-cli/Codex CLI.app/Contents/MacOS/codex\n', NOW).map((process) => process.program)).toEqual([
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/Codex CLI.app/Contents/MacOS/codex',
    ]);
  });

  it('leaves out lines that say no process', () => {
    expect(processesOf('\n  PID ELAPSED COMM\n', NOW)).toEqual([]);
  });
});
