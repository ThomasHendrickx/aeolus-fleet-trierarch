import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';
import { z } from 'zod';

import { aMachine } from '../../support/machine.js';

it('fails with a command running', async () => {
  const machine = await aMachine();
  machine.start(['follow', process.env.PROCESS_CLEANUP_ENDING ?? 'ignores']);
  const pidFile = join(machine.home, 'command.pid');
  await expect.poll(() => existsSync(pidFile)).toBe(true);
  const pids = z.tuple([z.number(), z.number()]).parse(JSON.parse(readFileSync(pidFile, 'utf8')));
  const recorded = [process.pid, ...pids].map((value) => {
    const stat = readFileSync(`/proc/${String(value)}/stat`, 'utf8');
    return { pid: value, start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] };
  });
  writeFileSync(process.env.PROCESS_CLEANUP_PIDS ?? '', JSON.stringify(recorded));
  throw new Error('the fixture test failed');
});
