import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CollectingLogger, TestClock } from '../../test/support/in-memory.js';
import { createLargestShips } from './largest-ships.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'largest-ships-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function ship(name: string, bytes: number): Promise<{ name: string; folder: string }> {
  const folder = join(root, name);
  await mkdir(folder);
  await writeFile(join(folder, 'data'), Buffer.alloc(bytes));
  return { name, folder };
}

describe('ships holding the most disk', () => {
  it('names the largest ships first without following links into host files', async () => {
    const small = await ship('small', 10);
    const large = await ship('large', 100);
    const host = await ship('host', 1000);
    await symlink(host.folder, join(small.folder, 'host'));
    const largest = createLargestShips({ clock: new TestClock(), logger: new CollectingLogger() });
    expect(await largest([small, large])).toEqual([{ name: 'large', bytes: 100 }, { name: 'small', bytes: 10 }]);
  });

  it('keeps readings for ten minutes and reads a replaced folder again', async () => {
    const small = await ship('small', 10);
    const other = await ship('other', 100);
    const clock = new TestClock();
    const largest = createLargestShips({ clock, logger: new CollectingLogger() });
    await largest([small]);
    await writeFile(join(small.folder, 'data'), Buffer.alloc(20));
    expect(await largest([small])).toEqual([{ name: 'small', bytes: 10 }]);
    expect(await largest([{ name: 'small', folder: other.folder }])).toEqual([{ name: 'small', bytes: 100 }]);
    clock.advance(600_000);
    expect(await largest([small])).toEqual([{ name: 'small', bytes: 20 }]);
  });

  it('still names measurable ships when a folder is gone', async () => {
    const present = await ship('present', 10);
    const logger = new CollectingLogger();
    const largest = createLargestShips({ clock: new TestClock(), logger });
    expect(await largest([{ name: 'gone', folder: join(root, 'gone') }, present])).toEqual([{ name: 'present', bytes: 10 }]);
    expect(logger.warnings[0]).toContain('Could not measure gone for low disk');
  });
});
