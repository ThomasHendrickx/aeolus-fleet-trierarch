import { cpSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CONFIGURATION, newId } from '../../test/support/in-memory.js';
import { NO_TERMINAL_QUESTIONS } from '@aeolus-fleet/common';

import { commandLinesOf, createHarnesses, riskyFlagsOf } from './harnesses.js';

const sessions = { start: () => Promise.resolve(), send: () => Promise.resolve(), interrupt: () => Promise.resolve(), events: () => Promise.resolve([]), lastEventAt: () => Promise.resolve(undefined) };
/** The aeolus-fleet plugin's own scripts from this repository, as a harness installs them in its plugin cache. */
const PLUGIN_ROOT = fileURLToPath(new URL('../../../../plugins/aeolus-fleet', import.meta.url));
const env = { AEOLUS_PLUGIN_ROOT: '/claude-plugin', AEOLUS_CODEX_PLUGIN_ROOT: '/codex-plugin' };

describe('the harnesses a trierarch offers', () => {
  it('has an adapter for each harness the configuration offers, and only those', async () => {
    const both = { ...CONFIGURATION, harnesses: { ...CONFIGURATION.harnesses, codex: { flags: [], options: {} } } };

    const { harnesses } = await createHarnesses({ configuration: both, homeDirectory: '/home/thomas', env, managedSettings: '/home/thomas/managed', detected: () => ({}), sessions });

    expect(Object.keys(harnesses).sort()).toEqual(['claude-code', 'codex']);
  });

  it('looks for the aeolus-fleet plugin of Codex only when the configuration offers Codex', async () => {
    const { plugins } = await createHarnesses({ configuration: CONFIGURATION, homeDirectory: '/home/thomas', env: { AEOLUS_PLUGIN_ROOT: '/claude-plugin' }, managedSettings: '/home/thomas/managed', detected: () => ({}), sessions });

    expect(Object.keys(plugins)).toEqual(['claude-code']);
  });

  it("names each configured harness's risky flags, as Thomas decided: skipping permissions in Claude Code, bypassing approvals and the sandbox in Codex (#326)", () => {
    const both = { ...CONFIGURATION, harnesses: { ...CONFIGURATION.harnesses, codex: { flags: [], options: {} } } };

    expect(riskyFlagsOf(both)).toEqual({ 'claude-code': ['--dangerously-skip-permissions'], codex: ['--dangerously-bypass-approvals-and-sandbox'] });
  });

  it('has an adapter for Copilot, with its plugin where AEOLUS_COPILOT_PLUGIN_ROOT says', async () => {
    const withCopilot = { ...CONFIGURATION, harnesses: { copilot: { flags: [], options: {} } } };

    const { harnesses, plugins } = await createHarnesses({ configuration: withCopilot, homeDirectory: '/home/thomas', env: { AEOLUS_COPILOT_PLUGIN_ROOT: '/copilot-plugin' }, managedSettings: '/home/thomas/managed', detected: () => ({}), sessions });

    expect({ harnesses: Object.keys(harnesses), root: await plugins.copilot?.root() }).toEqual({ harnesses: ['copilot'], root: '/copilot-plugin' });
  });

  it('offers Copilot on the version detection found when its plugin is proven on it, and not on the container runtime (CC3, CC10)', async () => {
    const withCopilot = { ...CONFIGURATION, harnesses: { copilot: { flags: [], options: {} } } };
    const detected = () => ({ copilot: { version: '1.0.105', detectedAt: new Date(), confirmedAt: null, options: {} } });
    const at = { configuration: withCopilot, homeDirectory: '/home/thomas', env: { AEOLUS_COPILOT_PLUGIN_ROOT: '/copilot-plugin' }, managedSettings: '/home/thomas/managed', detected, sessions };

    const onHost = (await createHarnesses(at)).harnesses.copilot;
    const inContainers = (await createHarnesses({ ...at, shipHomes: { homes: '/home/thomas/.aeolus/trierarch/homes', managedSettings: '/home/thomas/managed' } })).harnesses.copilot;

    expect({ onHost: await onHost?.notOfferedReason(), inContainers: await inContainers?.notOfferedReason() }).toEqual({ onHost: undefined, inContainers: 'Copilot is not proven in a container: the container runtime runs claude-code only' });
  });

  it("names Copilot's risky flags: every path and every URL, beyond the tools every launch allows (#326)", () => {
    expect(riskyFlagsOf({ ...CONFIGURATION, harnesses: { copilot: { flags: [], options: {} } } })).toEqual({ copilot: ['--allow-all', '--yolo', '--allow-all-paths', '--allow-all-urls'] });
  });

  it('shows the command lines Copilot starts with, for config check', async () => {
    const lines = await commandLinesOf({ harness: 'copilot', flags: ['--model', 'auto'], files: { claudeCode: { defaultPermissionMode: () => Promise.reject(new Error('Copilot reads no Claude Code settings')) } }, permissionModes: undefined });

    expect(lines?.firstStart.flatMap((part) => part.words)).toEqual(['copilot', '--model', 'auto', '--output-format=json', '--allow-all-tools', '--no-ask-user', `--prompt=<first prompt>\n\n${NO_TERMINAL_QUESTIONS}`]);
  });

  it('refuses a configured harness it has no adapter for, naming it', async () => {
    const withPi = { ...CONFIGURATION, harnesses: { pi: { flags: [], options: {} } } };

    await expect(createHarnesses({ configuration: withPi, homeDirectory: '/home/thomas', env, managedSettings: '/home/thomas/managed', detected: () => ({}), sessions })).rejects.toThrow('no adapter for the harness pi');
  });

  it.each(['claude-code', 'codex'] as const)("follows the %s plugin cache to the version a plugin upgrade moved it to, so a crew after the upgrade still starts without a service restart (#828)", async (harness) => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'trierarch-upgraded-home-')));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'trierarch-upgraded-session-')));
    try {
      const cache = join(home, harness === 'codex' ? '.codex' : '.claude', 'plugins', 'cache', 'aeolus-fleet', 'aeolus-fleet');
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
