import { cpSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CONFIGURATION, newId } from '../../test/support/in-memory.js';
import { createHarnesses, riskyFlagsOf } from './harnesses.js';

const sessions = { start: () => Promise.resolve(), type: () => Promise.resolve(), screen: () => Promise.resolve('') };
/** The aeolus plugin's own scripts from this repository, as a harness installs them in its plugin cache. */
const PLUGIN_ROOT = fileURLToPath(new URL('../../../../plugins/aeolus', import.meta.url));
const env = { AEOLUS_PLUGIN_ROOT: '/claude-plugin', AEOLUS_CODEX_PLUGIN_ROOT: '/codex-plugin' };

describe('the harnesses a trierarch offers', () => {
  it('has an adapter for each harness the configuration offers, and only those', async () => {
    const both = { ...CONFIGURATION, harnesses: { ...CONFIGURATION.harnesses, codex: { flags: [], options: {} } } };

    const { harnesses } = await createHarnesses({ configuration: both, homeDirectory: '/home/thomas', env, managedSettings: '/home/thomas/managed', detected: () => ({}), sessions });

    expect(Object.keys(harnesses).sort()).toEqual(['claude-code', 'codex']);
  });

  it('looks for the aeolus plugin of Codex only when the configuration offers Codex', async () => {
    const { plugins } = await createHarnesses({ configuration: CONFIGURATION, homeDirectory: '/home/thomas', env: { AEOLUS_PLUGIN_ROOT: '/claude-plugin' }, managedSettings: '/home/thomas/managed', detected: () => ({}), sessions });

    expect(Object.keys(plugins)).toEqual(['claude-code']);
  });

  it("names each configured harness's risky flags, as Thomas decided: skipping permissions in Claude Code, bypassing approvals and the sandbox in Codex (#326)", () => {
    const both = { ...CONFIGURATION, harnesses: { ...CONFIGURATION.harnesses, codex: { flags: [], options: {} } } };

    expect(riskyFlagsOf(both)).toEqual({ 'claude-code': ['--dangerously-skip-permissions'], codex: ['--dangerously-bypass-approvals-and-sandbox'] });
  });

  it('refuses a configured harness it has no adapter for, naming it', async () => {
    const withPi = { ...CONFIGURATION, harnesses: { pi: { flags: [], options: {} } } };

    await expect(createHarnesses({ configuration: withPi, homeDirectory: '/home/thomas', env, managedSettings: '/home/thomas/managed', detected: () => ({}), sessions })).rejects.toThrow('no adapter for the harness pi');
  });

  it.each(['claude-code', 'codex'] as const)("follows the %s plugin cache to the version a plugin upgrade moved it to, so a crew after the upgrade still starts without a service restart (#828)", async (harness) => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'trierarch-upgraded-home-')));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'trierarch-upgraded-session-')));
    try {
      const cache = join(home, harness === 'codex' ? '.codex' : '.claude', 'plugins', 'cache', 'aeolus-fleet', 'aeolus');
      cpSync(PLUGIN_ROOT, join(cache, '0.25.0'), { recursive: true });
      const configuration = { ...CONFIGURATION, harnesses: { [harness]: { flags: [], options: {} } } };
      const { harnesses } = await createHarnesses({ configuration, homeDirectory: home, env: {}, managedSettings: join(home, 'managed'), detected: () => ({}), sessions });

      renameSync(join(cache, '0.25.0'), join(cache, '0.25.1'));
      const shipId = newId('ship');
      await harnesses[harness]?.prepareIdentity({ folder, identity: { fleetUrl: 'https://fleet.example.com', shipId, shipName: 'scout', socket: `/home/thomas/.aeolus/trierarch/sockets/${shipId}/fleet.sock` }, crewToken: 'aeolus_ct_v1_of_the_crew' });

      await expect(harnesses[harness]?.hasIdentity({ shipId, folder })).resolves.toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
