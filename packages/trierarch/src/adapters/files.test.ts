import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { trierarchConfigurationSchema } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../../test/support/in-memory.js';
import { initialConfiguration, loadConfiguration, readCrewFile, writeCrewFile } from './files.js';

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'trierarch-files-'));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('the crew file', () => {
  it("keeps the fleet URL, the trierarch's ship id and its crew token, readable by its user only", async () => {
    const path = join(folder, 'crew-token');
    const crew = { fleetUrl: 'https://fleet.example.com', shipId: newId('ship'), crewToken: 'aeolus_ct_v1_trierarch' };

    await writeCrewFile(path, crew);

    expect(statSync(path).mode & 0o777).toBe(0o600);
    await expect(readCrewFile(path)).resolves.toEqual(crew);
  });

  it('reads a crew file written without the ship id', async () => {
    const path = join(folder, 'crew-token');
    writeFileSync(path, 'fleetUrl=https://fleet.example.com\ncrewToken=aeolus_ct_v1_trierarch\n');

    await expect(readCrewFile(path)).resolves.toEqual({ fleetUrl: 'https://fleet.example.com', crewToken: 'aeolus_ct_v1_trierarch' });
  });

  it('says to run init when there is none', async () => {
    await expect(readCrewFile(join(folder, 'crew-token'))).rejects.toThrow('run aeolus-trierarch init first');
  });
});

describe('the configuration file', () => {
  it('a fresh one fits its schema and adds no flag', () => {
    const configuration = initialConfiguration();

    expect(trierarchConfigurationSchema.safeParse(configuration).error).toBeUndefined();
    expect(configuration.harnesses['claude-code']?.flags).toEqual([]);
  });

  it('loads one that fits', async () => {
    const path = join(folder, 'config.json');
    writeFileSync(path, JSON.stringify(initialConfiguration()));

    await expect(loadConfiguration(path)).resolves.toMatchObject({ caps: { ships: 4, running: 2 } });
  });

  it.each([
    { label: 'is missing', text: undefined, says: 'run aeolus-trierarch init first' },
    { label: 'is no JSON', text: '{caps', says: 'is no JSON' },
    { label: 'does not fit, naming the field', text: JSON.stringify({ ...initialConfiguration(), sandbox: true }), says: 'sandbox' },
  ])('refuses one that $label', async ({ text, says }) => {
    const path = join(folder, 'config.json');
    if (text !== undefined) {
      writeFileSync(path, text);
    }

    await expect(loadConfiguration(path)).rejects.toThrow(says);
  });

  it('never holds the crew token: that lives in the crew file', async () => {
    const path = join(folder, 'crew-token');
    await writeCrewFile(path, { fleetUrl: 'https://fleet.example.com', crewToken: 'aeolus_ct_v1_trierarch' });

    expect(JSON.stringify(initialConfiguration())).not.toContain('crewToken');
    expect(readFileSync(path, 'utf8')).toContain('crewToken=');
  });
});
