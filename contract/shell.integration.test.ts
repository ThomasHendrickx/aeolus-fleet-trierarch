import { join } from 'node:path';

import { expect, it } from 'vitest';

import { aMachine, runProgram } from './support/machine.js';

it('passes other detached commands through the machine shell', async () => {
  const machine = await aMachine();
  const env = { HOME: machine.home, PATH: `${join(machine.machine, 'bin')}:${join(machine.machine, 'tools')}` };
  const result = await runProgram(['sh', '-c', '"$@" < /dev/null > /dev/null 2>&1 &', 'sh', '/bin/true'], { cwd: machine.home, env });
  expect(result.status, result.stderr).toBe(0);
});
