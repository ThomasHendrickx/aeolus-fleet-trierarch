import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { trierarchConfigurationSchema } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../../test/support/in-memory.js';
import { configurationJsonSchema, initialConfiguration, loadConfiguration, readCrewFile, readRunningFile, writeCrewFile, writeRunningFile } from './files.js';

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

  it("keeps the trierarch plugin's ship beside them, which the trusted repositories come from (aeolus-fleet#384)", async () => {
    const path = join(folder, 'crew-token');
    const crew = { fleetUrl: 'https://fleet.example.com', shipId: newId('ship'), pluginShipId: newId('ship'), crewToken: 'aeolus_ct_v1_trierarch' };

    await writeCrewFile(path, crew);

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

describe('the running file', () => {
  it('keeps the pid and the version of the trierarch that runs', async () => {
    const path = join(folder, 'running.json');

    await writeRunningFile(path, { pid: 4242, version: '0.17.4' });

    await expect(readRunningFile(path)).resolves.toEqual({ pid: 4242, version: '0.17.4' });
  });

  it('is none when no trierarch wrote it, or it does not fit', async () => {
    const path = join(folder, 'running.json');
    await expect(readRunningFile(path)).resolves.toBeUndefined();

    writeFileSync(path, '{"pid":"4242"}');

    await expect(readRunningFile(path)).resolves.toBeUndefined();
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

  describe("a repository's read-only checkouts (#1182)", () => {
    const withCheckouts = (checkouts: readonly string[]) => ({
      ...initialConfiguration(),
      repositories: { 'aeolus-company': { path: '/code/aeolus-company', checkouts }, governance: { path: '/code/governance' }, skills: { path: '/code/skills' } },
    });

    it('loads the configured repositories a session in a repository gets as read-only checkouts', async () => {
      const path = join(folder, 'config.json');
      writeFileSync(path, JSON.stringify(withCheckouts(['governance', 'skills'])));

      await expect(loadConfiguration(path)).resolves.toMatchObject({ repositories: { 'aeolus-company': { checkouts: ['governance', 'skills'] } } });
    });

    it.each([
      { label: 'a repository the configuration does not have', checkouts: ['hemma'], says: 'hemma is no repository of this configuration' },
      { label: 'the repository itself, which is the working folder', checkouts: ['aeolus-company'], says: 'aeolus-company is the repository itself' },
      { label: 'the same repository twice', checkouts: ['skills', 'skills'], says: 'skills is named twice' },
    ])('refuses a checkout of $label', async ({ checkouts, says }) => {
      const path = join(folder, 'config.json');
      writeFileSync(path, JSON.stringify(withCheckouts(checkouts)));

      await expect(loadConfiguration(path)).rejects.toThrow(says);
    });

    it('states the checkouts in the schema an editor checks it with', () => {
      expect(JSON.stringify(configurationJsonSchema())).toContain('"checkouts"');
    });
  });

  describe('the price table the cost of tokens is estimated by (#353)', () => {
    const withPrices = (prices: unknown) => ({ ...initialConfiguration(), prices });

    it('loads a price per model, in US dollars per million tokens of each kind', async () => {
      const path = join(folder, 'config.json');
      writeFileSync(path, JSON.stringify(withPrices({ 'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 } })));

      await expect(loadConfiguration(path)).resolves.toMatchObject({ prices: { 'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 } } });
    });

    it.each([
      { label: 'a negative price', prices: { 'gpt-6-sol': { input: -1, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } } },
      { label: 'a price without its cache write', prices: { 'gpt-6-sol': { input: 2, output: 10, cacheRead: 0.2 } } },
    ])('refuses $label', async ({ prices }) => {
      const path = join(folder, 'config.json');
      writeFileSync(path, JSON.stringify(withPrices(prices)));

      await expect(loadConfiguration(path)).rejects.toThrow('prices');
    });
  });

  it('never holds the crew token: that lives in the crew file', async () => {
    const path = join(folder, 'crew-token');
    await writeCrewFile(path, { fleetUrl: 'https://fleet.example.com', shipId: newId('ship'), crewToken: 'aeolus_ct_v1_trierarch' });

    expect(JSON.stringify(initialConfiguration())).not.toContain('crewToken');
    expect(readFileSync(path, 'utf8')).toContain('crewToken=');
  });
});
