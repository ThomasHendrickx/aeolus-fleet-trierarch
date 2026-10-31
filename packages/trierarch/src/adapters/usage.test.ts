import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { newId } from '../../test/support/in-memory.js';
import { createUsage, folderMadeAt } from './usage.js';

const NONE = { tokensOf: () => Promise.resolve([]), subscription: () => Promise.resolve(undefined) };

describe("the harnesses' usage, each from its own reader (#353)", () => {
  it("reads a ship's tokens and a subscription from the reader of its harness", async () => {
    const tokens = [{ model: 'gpt-6.1-sol', hour: new Date('2026-10-12T07:00:00.000Z'), tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }];
    const windows = [{ windowMinutes: 300, usedPercent: 17, resetsAt: new Date('2026-10-12T08:00:00.000Z') }];
    const usage = createUsage({ 'claude-code': NONE, codex: { tokensOf: () => Promise.resolve(tokens), subscription: () => Promise.resolve(windows) } });

    expect([await usage.tokensOf({ shipId: newId('ship'), harness: 'codex', folder: '/code/scout' }), await usage.subscriptionOf('codex')]).toEqual([tokens, windows]);
  });

  it('says no tokens and no subscription of a harness it has no reader for', async () => {
    const usage = createUsage({ 'claude-code': NONE });

    expect([await usage.tokensOf({ shipId: newId('ship'), harness: 'gemini', folder: '/code/scout' }), await usage.subscriptionOf('gemini')]).toEqual([[], undefined]);
  });

  it('dates a folder from when it was made', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'aeolus-made-'));
    try {
      const madeAt = (await folderMadeAt(folder)).getTime();
      const after = Date.now();

      // Some filesystems keep whole seconds or less; on macOS the filesystem's clock can run a millisecond ahead of the process's.
      expect(madeAt).toBeGreaterThanOrEqual(after - 1000);
      expect(madeAt).toBeLessThanOrEqual(after + 1);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
