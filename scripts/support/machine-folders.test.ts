import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { expect, it } from 'vitest';

import { aMachine } from '../../contract/support/machine.js';
import { SHORT_FOLDER_VARIABLE } from './test-folders.js';

// A machine fixture links system programs and initializes a Git repository.
const MACHINE_SETUP_TIMEOUT_MS = 30_000;

it('gives each contract machine its own short folder and keeps earlier contents', async () => {
  const shortFolder = process.env[SHORT_FOLDER_VARIABLE];
  if (shortFolder === undefined) throw new Error('expected a short folder from test setup');

  const underTest = [process.execPath, '--version'];
  const first = await aMachine({ underTest });
  const firstRoot = dirname(first.home);
  const marker = join(firstRoot, 'left');
  writeFileSync(marker, 'keep');

  const second = await aMachine({ underTest });
  const secondRoot = dirname(second.home);

  expect(dirname(firstRoot)).toBe(realpathSync(shortFolder));
  expect(dirname(secondRoot)).toBe(realpathSync(shortFolder));
  expect(secondRoot).not.toBe(firstRoot);
  expect(readFileSync(marker, 'utf8')).toBe('keep');
}, MACHINE_SETUP_TIMEOUT_MS);
