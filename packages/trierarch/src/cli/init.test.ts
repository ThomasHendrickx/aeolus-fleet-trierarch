import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { trierarchConfigurationSchema, type ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { trierarchPaths, type TrierarchPaths } from '../adapters/paths.js';
import { newId } from '../../test/support/in-memory.js';
import { initTrierarch } from './init.js';

const SECRET = 'aeolus_sk_v1_trierarch-secret';

let home: string;
let paths: TrierarchPaths;
let registered: { fleetUrl: string; shipId: ShipId; secret: string }[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'trierarch-init-'));
  paths = trierarchPaths({ homeDirectory: home });
  registered = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function init(shipId: ShipId = newId('ship')) {
  return initTrierarch({
    paths,
    crew: { fleetUrl: 'https://fleet.example.com/', shipId, secret: SECRET },
    fleetAt: (fleetUrl) => ({
      registerSelf: (crew) => {
        registered.push({ fleetUrl, ...crew });
        return Promise.resolve({ crewToken: 'aeolus_ct_v1_trierarch' });
      },
    }),
  });
}

describe('aeolus-trierarch init', () => {
  it("registers the trierarch's own ship with its secret and keeps the crew token, readable by its user only", async () => {
    const shipId = newId('ship');

    await init(shipId);

    expect(registered).toEqual([{ fleetUrl: 'https://fleet.example.com/', shipId, secret: SECRET }]);
    expect(readFileSync(paths.crewToken, 'utf8')).toBe('fleetUrl=https://fleet.example.com\ncrewToken=aeolus_ct_v1_trierarch\n');
    expect(statSync(paths.crewToken).mode & 0o777).toBe(0o600);
  });

  it('writes a configuration under ~/.aeolus/trierarch/ that fits, with its JSON Schema beside it and no flag', async () => {
    await init();

    const configuration: unknown = JSON.parse(readFileSync(join(home, '.aeolus', 'trierarch', 'config.json'), 'utf8'));
    expect(trierarchConfigurationSchema.safeParse(configuration).error).toBeUndefined();
    expect(JSON.stringify(configuration)).not.toContain('--');
    expect(existsSync(paths.configSchema)).toBe(true);
  });

  it('keeps a configuration the operator wrote', async () => {
    await init();
    writeFileSync(paths.config, '{"mine": true}');

    await init();

    expect(readFileSync(paths.config, 'utf8')).toBe('{"mine": true}');
  });

  it('never writes the secret', async () => {
    await init();

    for (const file of readdirSync(paths.home)) {
      expect(readFileSync(join(paths.home, file), 'utf8')).not.toContain(SECRET);
    }
  });
});
