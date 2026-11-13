import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { REPOSITORY } from './support/crewing.js';
import { aMachine, type Machine } from './support/machine.js';

// A configuration that still names checkouts (docs/trierarch.md, "Ship folder"): refused, since a ship's sub-repositories come from its crew request.

let machine: Machine;

beforeEach(async () => {
  machine = await aMachine();
});

afterEach(async () => {
  await machine.remove();
});

describe('a configuration that still names checkouts', () => {
  const refusal = (): string => `The configuration at ${join(machine.trierarchHome, 'config.json')} names checkouts in repository ${REPOSITORY}: remove that line; a ship's sub-repositories come from its crew request`;

  function configureCheckouts(): void {
    const file = join(machine.trierarchHome, 'config.json');
    const configuration = z.object({ repositories: z.record(z.string(), z.object({ path: z.string() })) }).loose().parse(JSON.parse(readFileSync(file, 'utf8')));
    const repository = { path: machine.repository, checkouts: ['skills'] };
    writeFileSync(file, JSON.stringify({ ...configuration, repositories: { ...configuration.repositories, [REPOSITORY]: repository } }));
  }

  for (const words of [['config', 'check'], ['run']]) {
    it(`is refused by ${words.join(' ')}, naming the line to remove and where sub-repositories come from`, async () => {
      configureCheckouts();

      const ran = await machine.trierarch(words);

      expect(ran.status).not.toBe(0);
      expect(ran.stdout + ran.stderr).toContain(refusal());
    });
  }
});
