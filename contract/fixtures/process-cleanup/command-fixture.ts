import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';
import { z } from 'zod';

import { aMachine, runProgram } from '../../support/machine.js';

it('fails with a command running', async () => {
  const machine = await aMachine();
  const ending = process.env.PROCESS_CLEANUP_ENDING ?? 'ignore';
  const command = ending === 'external' ? undefined : machine.start(['follow', ending === 'interrupt' ? 'exit' : ending]);
  if (ending === 'external') {
    void runProgram([...machine.underTest, 'follow', 'ignore'], { cwd: machine.home, env: { HOME: machine.home, PATH: `${join(machine.machine, 'bin')}:${join(machine.machine, 'tools')}` } });
  }
  const pidFile = join(machine.home, 'command.pid');
  // A cold start of the command's node under a busy run takes longer than a poll's default second.
  await expect.poll(() => existsSync(pidFile), { timeout: 20_000 }).toBe(true);
  const pids = z.tuple([z.number(), z.number()]).parse(JSON.parse(readFileSync(pidFile, 'utf8')));
  const recorded = [process.pid, ...pids].map((value) => {
    const stat = readFileSync(`/proc/${String(value)}/stat`, 'utf8');
    return { pid: value, start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] };
  });
  writeFileSync(process.env.PROCESS_CLEANUP_PIDS ?? '', JSON.stringify(recorded));
  if (ending === 'interrupt') await command?.interrupt();
  throw new Error('the fixture test failed');
});
