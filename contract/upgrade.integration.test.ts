import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import { aCrewingMachine } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine } from './support/machine.js';
import { aBinaryThatDoesNotStart, aReleaseSource, type Fault, type ReleaseSource } from './support/release.js';

// upgrade on the version the trierarch runs: it installs nothing and updates the aeolus-fleet plugin through each offered harness's own commands (docs/trierarch.md, "A machine joins"). Another version comes from its GitHub Release when it carries a binary for the machine's system and chip, checked against SHA256SUMS and its attestation, put in ~/.local/bin/aeolus-trierarch, the old file left or put back when that fails: in place of the trierarch's own file, or beside today's trierarch, which moves to the binary that way (#142).

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

const built = () => inject('release');

describe('upgrade to another version from its GitHub Release', () => {
  let source: ReleaseSource | undefined;

  afterEach(async () => {
    await source?.close();
    source = undefined;
  });

  /** The digest of ~/.local/bin/aeolus-trierarch, where a release's binary goes; none when there is no file, as beside today's trierarch before it moved. */
  const installed = (): string | undefined => {
    const file = join(machine.home, '.local', 'bin', 'aeolus-trierarch');
    return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : undefined;
  };
  const runningVersion = async (): Promise<string | undefined> => z.object({ runningVersion: z.string().optional() }).parse(JSON.parse((await machine.trierarch(['status', '--json'])).stdout)).runningVersion;

  it("installs the release's binary in ~/.local/bin, and the service runs it", async () => {
    source = await aReleaseSource(built());

    const upgrade = await machine.trierarch(['upgrade', source.version, '--json'], { env: source.env });

    expect(upgrade.status, upgrade.stdout + upgrade.stderr).toBe(0);
    expect(reportSchema.parse(JSON.parse(upgrade.stdout))).toEqual({ from: version, to: source.version, isUpgraded: true, isPluginUpdated: true });
    expect(installed()).toBe(createHash('sha256').update(source.binary).digest('hex'));
    expect(await runningVersion()).toBe(source.version);
    expect(machine.callsOf('claude')).toContain(`${MARKETPLACE}#v${source.version}`);
  });

  it.each<Fault>(['bad checksum', 'bad attestation'])('leaves the old binary in place, the service running it, on a %s', async (fault) => {
    source = await aReleaseSource(built(), { fault });
    const before = installed();
    const pid = machine.servicePid();
    const pluginCalls = machine.callsOf('claude').filter((call) => call.startsWith('plugin '));

    const upgrade = await machine.trierarch(['upgrade', source.version, '--json'], { env: source.env });

    expect(upgrade.status, upgrade.stdout).toBe(1);
    expect(installed()).toBe(before);
    expect(machine.servicePid()).toBe(pid);
    expect(await runningVersion()).toBe(version);
    expect(machine.callsOf('claude').filter((call) => call.startsWith('plugin '))).toEqual(pluginCalls);
  });

  it('puts the old binary back when the new one does not start, and the service runs it again', async () => {
    source = await aReleaseSource(built(), { binary: aBinaryThatDoesNotStart(built().version) });
    const before = installed();

    const upgrade = await machine.trierarch(['upgrade', source.version, '--json'], { env: source.env });

    expect(upgrade.status, upgrade.stdout).toBe(1);
    expect(upgrade.stdout).toContain('did not start');
    expect(installed()).toBe(before);
    expect(await runningVersion()).toBe(version);
  });
});
