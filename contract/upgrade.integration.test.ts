import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import { aCrewingMachine } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine, type OtherHarness } from './support/machine.js';
import { aBinaryThatDoesNotStart, aReleaseSource, type Fault, type ReleaseSource } from './support/release.js';

// upgrade on the version the trierarch runs: it installs nothing and updates the aeolus-fleet plugin through each offered harness's own commands (docs/trierarch.md, "A machine joins"). Another version comes from its GitHub Release when it carries a binary for the machine's system and chip, checked against SHA256SUMS and its attestation, put in ~/.local/bin/aeolus-trierarch, the old file left or put back when that fails: in place of the trierarch's own file, or beside today's trierarch, which moves to the binary that way (#142).

/** The plugin's marketplace, as Claude Code adds it: the repository, at a release tag or main. */
const MARKETPLACE = 'plugin marketplace add ThomasHendrickx/aeolus-fleet-trierarch';

let fleet: Fleet;
let machine: Machine;
let version: string;

/** Each test of the block on a crewing machine with Claude Code and the other harnesses given. */
function onACrewingMachine(others: readonly OtherHarness[] = []): void {
  beforeEach(async () => {
    fleet = await aFleet();
    machine = await aMachine({ others });
    await aCrewingMachine({ fleet, machine });
    version = z.object({ version: z.string() }).parse(JSON.parse((await machine.trierarch(['--version', '--json'])).stdout)).version;
  });
}

afterEach(async ({ task }) => {
  if (task.result?.state === 'fail') {
    console.log(`The service's log:\n${machine.serviceLog()}`);
  }
  await machine.remove();
  await fleet.close();
});

const reportSchema = z.object({ from: z.string(), to: z.string(), isUpgraded: z.boolean(), isPluginUpdated: z.boolean() });

describe('upgrade on the version it runs', () => {
  onACrewingMachine();

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
  onACrewingMachine();

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

/** The plugin's marketplace, as Codex adds it: the repository, at a release tag or main. */
const CODEX_MARKETPLACE = 'plugin marketplace add ThomasHendrickx/aeolus-fleet-trierarch';

describe("upgrade with Codex on offer updates Codex's aeolus-fleet plugin", () => {
  onACrewingMachine(['codex']);

  const codexHome = () => join(machine.home, '.codex');
  const cache = () => join(codexHome(), 'plugins', 'cache', 'aeolus-fleet', 'aeolus-fleet');
  const versionFolders = () => (existsSync(cache()) ? readdirSync(cache()).sort() : []);
  /** A version folder of the plugin in Codex's cache, as its version came at the time given. */
  const aVersionFolder = (folder: string, came: Date) => {
    mkdirSync(join(cache(), folder, '.codex-plugin'), { recursive: true });
    writeFileSync(join(cache(), folder, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'aeolus-fleet', version: folder }));
    utimesSync(join(cache(), folder), came, came);
  };

  it("points its marketplace at the release tag and upgrades it through Codex's own plugin commands", async () => {
    aVersionFolder('0.2.0', new Date('2020-01-02T00:00:00Z'));

    const upgrade = await machine.trierarch(['upgrade', version, '--json']);

    expect(upgrade.status, upgrade.stdout + upgrade.stderr).toBe(0);
    expect(reportSchema.parse(JSON.parse(upgrade.stdout))).toEqual({ from: version, to: version, isUpgraded: false, isPluginUpdated: true });
    const calls = machine.callsOf('codex');
    expect(calls.some((call) => call.startsWith(CODEX_MARKETPLACE))).toBe(true);
    expect(calls).toEqual(expect.arrayContaining(['plugin marketplace remove aeolus-fleet', 'plugin marketplace upgrade aeolus-fleet', 'plugin remove aeolus@aeolus-fleet']));
  });

  it('adds the plugin when Codex holds no version of it', async () => {
    const upgrade = await machine.trierarch(['upgrade', version, '--json']);

    expect(upgrade.status, upgrade.stdout + upgrade.stderr).toBe(0);
    expect(machine.callsOf('codex')).toContain('plugin add aeolus-fleet@aeolus-fleet');
    expect(versionFolders()).toEqual([version]);
  });

  it('puts back the version folder a running process may use, and removes the one none can', async () => {
    // 0.2.0 came before the service's trierarch started, so it left 0.1.0 behind; 0.3.0, which the upgrade installs, came after it started.
    aVersionFolder('0.1.0', new Date('2020-01-01T00:00:00Z'));
    aVersionFolder('0.2.0', new Date('2020-01-02T00:00:00Z'));
    writeFileSync(join(machine.machine, 'codex-marketplace-version'), '0.3.0');

    const upgrade = await machine.trierarch(['upgrade', version, '--json']);

    expect(upgrade.status, upgrade.stdout + upgrade.stderr).toBe(0);
    expect(versionFolders()).toEqual(['0.2.0', '0.3.0']);
  });

  it('puts back each version folder Codex deleted when its upgrade fails, and exits 1', async () => {
    aVersionFolder('0.2.0', new Date('2020-01-02T00:00:00Z'));
    machine.toggle('codex-plugin-fails', true);

    const upgrade = await machine.trierarch(['upgrade', version, '--json']);

    expect(upgrade.status, upgrade.stdout).toBe(1);
    expect(reportSchema.parse(JSON.parse(upgrade.stdout))).toMatchObject({ isUpgraded: false, isPluginUpdated: false });
    expect(versionFolders()).toEqual(['0.2.0']);
  });

  it("changes nothing when this Codex deletes the plugin's data with its marketplace, proven in a throwaway Codex home, and exits 1", async () => {
    const data = join(codexHome(), 'plugins', 'data', 'aeolus-fleet-aeolus-fleet');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'mark'), 'kept\n');
    machine.toggle('codex-deletes-plugin-data', true);

    const upgrade = await machine.trierarch(['upgrade', version, '--json']);

    expect(upgrade.status, upgrade.stdout).toBe(1);
    expect(reportSchema.parse(JSON.parse(upgrade.stdout))).toMatchObject({ isPluginUpdated: false });
    expect(machine.callsOf('codex').filter((call) => call.startsWith(CODEX_MARKETPLACE) || call === 'plugin marketplace upgrade aeolus-fleet')).toEqual([]);
    expect(readFileSync(join(data, 'mark'), 'utf8')).toBe('kept\n');
  });

  it("trusts the plugin's new hooks through Codex's app server", async () => {
    machine.toggle('codex-untrusted-hook', true);

    const upgrade = await machine.trierarch(['upgrade', version, '--json']);

    expect(upgrade.status, upgrade.stdout + upgrade.stderr).toBe(0);
    expect(readFileSync(join(codexHome(), 'config.toml'), 'utf8')).toContain('[hooks.state."aeolus-fleet@aeolus-fleet:hooks/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:5f1d"');
  });
});
