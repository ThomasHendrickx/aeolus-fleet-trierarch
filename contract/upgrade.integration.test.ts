import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { aCrewingMachine } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine } from './support/machine.js';

// upgrade on the version the trierarch runs: it installs nothing and updates the aeolus-fleet plugin through each offered harness's own commands (docs/trierarch.md, "A machine joins"). Installing another version, and putting the old one back when that fails, come from where a release is fetched, which the Go trierarch changes (#104): they are not in the suite yet.

/** The plugin's marketplace, as Claude Code adds it: the repository, at a release tag or main. */
const MARKETPLACE = 'plugin marketplace add ThomasHendrickx/aeolus-fleet-trierarch';

let fleet: Fleet;
let machine: Machine;
let version: string;

beforeEach(async () => {
  fleet = await aFleet();
  machine = await aMachine();
  await aCrewingMachine({ fleet, machine });
  version = z.object({ version: z.string() }).parse(JSON.parse((await machine.trierarch(['--version', '--json'])).stdout)).version;
});

afterEach(async ({ task }) => {
  if (task.result?.state === 'fail') {
    console.log(`The service's log:\n${machine.serviceLog()}`);
  }
  await machine.remove();
  await fleet.close();
});

const reportSchema = z.object({ from: z.string(), to: z.string(), isUpgraded: z.boolean(), isPluginUpdated: z.boolean() });

describe('upgrade on the version it runs', () => {
  it('installs nothing and says it is on that version', async () => {
    const upgrade = await machine.trierarch(['upgrade', version, '--json']);

    expect(upgrade.status, upgrade.stdout + upgrade.stderr).toBe(0);
    expect(reportSchema.parse(JSON.parse(upgrade.stdout))).toEqual({ from: version, to: version, isUpgraded: false, isPluginUpdated: true });
  });

  it("updates the aeolus-fleet plugin through Claude Code's own plugin commands", async () => {
    await machine.trierarch(['upgrade', version, '--json']);

    const calls = machine.callsOf('claude').filter((call) => call.startsWith('plugin '));

    expect(calls.some((call) => call.startsWith(MARKETPLACE))).toBe(true);
    expect(calls).toEqual(expect.arrayContaining(['plugin marketplace update aeolus-fleet', 'plugin update aeolus-fleet@aeolus-fleet']));
  });

  it('exits 1 and says so when the plugin cannot be updated, and the service keeps running', async () => {
    machine.toggle('claude-plugin-fails', true);
    const pid = machine.servicePid();

    const upgrade = await machine.trierarch(['upgrade', version, '--json']);

    expect(upgrade.status).toBe(1);
    expect(reportSchema.parse(JSON.parse(upgrade.stdout))).toMatchObject({ isUpgraded: false, isPluginUpdated: false });
    expect(machine.servicePid()).toBe(pid);
  });

  it('refuses a word that is no version, and changes nothing', async () => {
    const upgrade = await machine.trierarch(['upgrade', 'newest']);

    expect(upgrade.status).toBe(1);
    expect(machine.callsOf('claude').filter((call) => call.startsWith('plugin '))).toEqual([]);
  });
});
