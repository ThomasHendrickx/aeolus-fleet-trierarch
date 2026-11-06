import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Detected } from '../core/ports.js';
import { createDetectedFile } from './detected-file.js';

const AT = new Date('2026-10-08T15:00:00.000Z');

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'trierarch-detected-'));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('the detected file (#365)', () => {
  it('keeps what was detected, times and all', async () => {
    const file = createDetectedFile(join(folder, 'detected.json'));
    const detected: Detected = {
      'claude-code': { version: '2.1.293', detectedAt: AT, confirmedAt: null, options: { effort: { values: { low: ['--effort', 'low'] } } }, problem: 'no model alias' },
      codex: { version: '0.160.1', detectedAt: AT, confirmedAt: AT, options: { model: { values: { 'gpt-6.1-sol': ['-m', 'gpt-6.1-sol'] }, default: 'gpt-6.1-sol' } } },
    };

    await file.save(detected);

    await expect(file.load()).resolves.toEqual(detected);
  });

  it('keeps the ids the machine refused, with when (#382)', async () => {
    const file = createDetectedFile(join(folder, 'detected.json'));
    const detected: Detected = {
      codex: { version: '0.160.1', detectedAt: AT, confirmedAt: AT, options: { model: { values: { 'gpt-5.6-sol': ['-m', 'gpt-5.6-sol'] } } }, refused: [{ id: 'gpt-6.1-sol', at: AT }] },
    };

    await file.save(detected);

    await expect(file.load()).resolves.toEqual(detected);
  });

  it('keeps the permission modes Claude Code lists (#517)', async () => {
    const file = createDetectedFile(join(folder, 'detected.json'));
    const detected: Detected = {
      'claude-code': { version: '2.1.296', detectedAt: AT, confirmedAt: AT, options: {}, permissionModes: ['acceptEdits', 'manual', 'plan'] },
    };

    await file.save(detected);

    await expect(file.load()).resolves.toEqual(detected);
  });

  it('holds nothing before the first detection', async () => {
    await expect(createDetectedFile(join(folder, 'detected.json')).load()).resolves.toEqual({});
  });

  it('holds nothing when the file does not fit, so detection runs again', async () => {
    const path = join(folder, 'detected.json');
    writeFileSync(path, '{"claude-code": {"version": 2}}');

    await expect(createDetectedFile(path).load()).resolves.toEqual({});
  });

  it('is never read empty or half written while it is saved again and again', async () => {
    const path = join(folder, 'detected.json');
    const file = createDetectedFile(path);
    const values = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`model-${i}`, ['--model', `model-${i}`]]));
    const detected: Detected = { codex: { version: '0.160.1', detectedAt: AT, confirmedAt: AT, options: { model: { values } } } };
    await file.save(detected);

    const state = { isSaving: true };
    const saves = (async () => {
      for (let i = 0; i < 100; i += 1) {
        await file.save(detected);
      }
      state.isSaving = false;
    })();
    let unparsable = 0;
    while (state.isSaving) {
      try {
        JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        unparsable += 1;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    await saves;

    expect(unparsable).toBe(0);
  });
});
