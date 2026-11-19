import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { measureShipFolder } from './ship-size.js';

describe('measuring a ship folder', () => {
  it('counts the files inside the folder without following links outside it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ship-size-'));
    try {
      const ship = join(root, 'ship');
      await mkdir(ship);
      await writeFile(join(ship, 'a'), 'abc');
      await mkdir(join(ship, 'home'));
      await writeFile(join(ship, 'home', 'b'), '12345');
      await writeFile(join(root, 'outside'), 'not part of the ship');
      await symlink(join(root, 'outside'), join(ship, 'link'));
      expect(await measureShipFolder(ship)).toBe(8);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
