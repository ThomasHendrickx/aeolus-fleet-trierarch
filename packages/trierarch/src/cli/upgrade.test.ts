import { beforeEach, describe, expect, it } from 'vitest';

import type { RunningFile } from '../adapters/files.js';
import type { CommandResult } from '../adapters/run-command.js';
import type { ServiceStatus } from '../adapters/service.js';
import type { PluginHarness } from '../adapters/plugin.js';
import { upgradeTrierarch, type Npm } from './upgrade.js';

const PACKAGE = '@aeolus-fleet/trierarch';

let installed: string;
let latest: string;
let lookups: number;
let installs: string[];
let failing: CommandResult | undefined;
let failingWrite: CommandResult | undefined;
let isGlobalFolderWritable: boolean;
let steps: string[];
let isServiceInstalled: boolean;
/** What running.json says on each read after the new process starts, the last one from then on. */
let saying: (RunningFile | undefined)[];
let reads: number;
let waits: number[];
/** The aeolus plugin's version per harness, as each harness reads it. */
let pluginVersions: Record<string, string | undefined>;
let offered: PluginHarness[];
let failingPluginUpdate: PluginHarness | undefined;
let isHookTrustFailing: boolean;
let isPluginLatest: boolean;
/** The release tag each harness installed the aeolus plugin from, none for main. */
let pluginTags: Partial<Record<PluginHarness, string | undefined>>;

beforeEach(() => {
  pluginVersions = { 'claude-code': '0.21.0', codex: '0.21.0' };
  // The configuration offers no harness unless a test says so: the plugin then stays as it is.
  offered = [];
  failingPluginUpdate = undefined;
  isHookTrustFailing = false;
  isPluginLatest = false;
  pluginTags = {};
  installed = '0.17.1';
  latest = '0.17.2';
  lookups = 0;
  installs = [];
  failing = undefined;
  failingWrite = undefined;
  isGlobalFolderWritable = true;
  steps = [];
  isServiceInstalled = true;
  saying = [{ pid: 2, version: '0.17.2' }];
  reads = 0;
  waits = [];
});

function running(): Promise<RunningFile | undefined> {
  reads += 1;
  return Promise.resolve(saying[Math.min(reads, saying.length) - 1]);
}

function sleep(ms: number): Promise<void> {
  waits.push(ms);
  return Promise.resolve();
}

const npm: Npm = {
  globalFolder: () => Promise.resolve({ path: '/usr/local/lib/node_modules', isWritable: isGlobalFolderWritable }),
  latest: () => {
    lookups += 1;
    return Promise.resolve(latest);
  },
  install: (spec) => {
    installs.push(spec);
    if (failing !== undefined) {
      return Promise.resolve(failing);
    }
    installed = spec.slice(spec.lastIndexOf('@') + 1);
    return Promise.resolve({ status: 0, stdout: '', stderr: '' });
  },
};

/** The installed version's own `install --no-load`: it writes the service's file as that version writes it. */
function writeInstalledServiceFile(): Promise<CommandResult> {
  if (failingWrite !== undefined) {
    return Promise.resolve(failingWrite);
  }
  steps.push(`write ${installed}`);
  return Promise.resolve({ status: 0, stdout: '', stderr: '' });
}

const service = {
  // The command that upgrades runs the code already in memory, the version it replaces.
  rewrite: () => {
    steps.push('rewrite 0.17.1');
    return Promise.resolve();
  },
  reload: () => {
    steps.push('reload');
    return Promise.resolve();
  },
  stop: () => {
    steps.push(`stop ${installed}`);
    return Promise.resolve();
  },
  start: () => {
    steps.push(`start ${installed}`);
    return Promise.resolve();
  },
  status: (): Promise<ServiceStatus> => Promise.resolve({ file: '/LaunchAgents/dev.aeolus-fleet.trierarch.plist', isInstalled: isServiceInstalled, isRunning: isServiceInstalled, ...(isServiceInstalled && { pid: 2 }) }),
};

/** The aeolus plugin as each harness updates it: the update brings 0.22.0. */
const plugin = {
  get harnesses() {
    return offered;
  },
  update: (harness: PluginHarness, tag: string | undefined) => {
    steps.push(`update ${harness}`);
    pluginTags[harness] = tag;
    if (failingPluginUpdate === harness) {
      return Promise.reject(new Error('codex plugin marketplace upgrade aeolus-fleet failed: could not reach github.com'));
    }
    if (!isPluginLatest) {
      pluginVersions[harness] = '0.22.0';
    }
    return Promise.resolve();
  },
  version: (harness: PluginHarness) => Promise.resolve(pluginVersions[harness]),
  trustCodexHooks: () => {
    steps.push('trust codex hooks');
    return isHookTrustFailing ? Promise.reject(new Error('codex app-server ended before it answered (exit 1)')) : Promise.resolve(['aeolus@aeolus-fleet:hooks/hooks.json:stop:0:0']);
  },
};

/** The installed version's own `upgrade <version> --json`: on the version already, it updates the aeolus plugin as that version does. */
let upgradeInstalledPlugin: (version: string) => Promise<CommandResult>;

beforeEach(() => {
  upgradeInstalledPlugin = async (version) => {
    const report = await upgrade(version);
    return { status: report.isPluginUpdated ? 0 : 1, stdout: JSON.stringify(report, null, 2), stderr: '' };
  };
});

/** The harnesses whose flags carried --remote-control, taken out of the configuration by the upgrade (headless H20). */
let remoteControlIn: string[];
/** How many times the upgrade took Remote Control out of the configuration. */
let remoteControlRemovals: number;

beforeEach(() => {
  remoteControlIn = [];
  remoteControlRemovals = 0;
});

const removeRemoteControl = () => {
  remoteControlRemovals += 1;
  const removed = remoteControlIn;
  remoteControlIn = [];
  return Promise.resolve(removed);
};

function upgrade(version?: string, at: { isPluginStepOfAnUpgrade?: boolean } = {}) {
  return upgradeTrierarch({ ...(version !== undefined && { version }), ...at, installedVersion: () => installed, npm, writeInstalledServiceFile, upgradeInstalledPlugin: (to) => upgradeInstalledPlugin(to), service, running, sleep, plugin, removeRemoteControl });
}

describe('aeolus-trierarch upgrade', () => {
  it("takes --remote-control out of the configuration as the version it installs, and says so, before the service starts on it (headless H20)", async () => {
    offered = ['claude-code'];
    remoteControlIn = ['claude-code'];

    const report = await upgrade();

    expect(remoteControlIn).toEqual([]);
    expect(report.said).toContain('Took --remote-control out of the flags of claude-code in the configuration: a session the trierarch runs has no terminal, so no Remote Control.');
    expect(report.said.indexOf('Took --remote-control out of the flags of claude-code in the configuration: a session the trierarch runs has no terminal, so no Remote Control.')).toBeLessThan(report.said.findIndex((line) => line.startsWith('The service runs')));
  });

  it('says nothing of Remote Control when the configuration has none', async () => {
    offered = ['claude-code'];

    const report = await upgrade();

    expect(remoteControlRemovals).toBe(1);
    expect(report.said.join('\n')).not.toContain('remote-control');
  });

  it('installs the latest version from npm, pinned to it, then stops the old process and starts the new one', async () => {
    const report = await upgrade();

    expect(installs).toEqual([`${PACKAGE}@0.17.2`]);
    expect(steps).toEqual(['write 0.17.2', 'reload', 'stop 0.17.2', 'start 0.17.2']);
    expect(report).toMatchObject({ from: '0.17.1', to: '0.17.2', isUpgraded: true });
    expect(report.said.join('\n')).toContain('Upgraded the trierarch from 0.17.1 to 0.17.2');
  });

  it('installs the version it is given, without asking npm for the latest', async () => {
    await upgrade('0.17.0');

    expect(installs).toEqual([`${PACKAGE}@0.17.0`]);
    expect(lookups).toBe(0);
  });

  it('rewrites the service\'s file before it stops the old process, so the stop already ends the trierarch only, as init writes it (#485)', async () => {
    await upgrade();

    expect(steps.slice(0, 3)).toEqual(['write 0.17.2', 'reload', 'stop 0.17.2']);
  });

  it('writes the service\'s file as the version it installs writes it, not as the version it replaces (#492)', async () => {
    await upgrade();

    expect(steps).not.toContain('rewrite 0.17.1');
    expect(steps[0]).toBe('write 0.17.2');
  });

  it('leaves the old process running when the installed version cannot write the service\'s file, saying what failed and what to do (#492)', async () => {
    failingWrite = { status: 1, stdout: '', stderr: 'EACCES: permission denied\n' };

    await expect(upgrade()).rejects.toThrow(
      'The trierarch 0.17.2 could not write the service\'s file: EACCES: permission denied\nThe service keeps running 0.17.1. Fix what it says, then run aeolus-trierarch install to write the file and restart the service.',
    );
    expect(steps).toEqual([]);
  });

  it('says it is already on a version and does nothing more', async () => {
    latest = '0.17.1';
    saying = [{ pid: 2, version: '0.17.1' }];

    const report = await upgrade();

    expect(installs).toEqual([]);
    expect(steps).toEqual([]);
    expect(report).toMatchObject({ from: '0.17.1', to: '0.17.1', isUpgraded: false, said: ['The trierarch is already on 0.17.1.'] });
  });

  it('keeps the old version running when the install fails, saying what failed and what to do', async () => {
    failing = { status: 1, stdout: '', stderr: 'npm error code EACCES\nnpm error permission denied\n' };

    await expect(upgrade()).rejects.toThrow(
      `npm install --global ${PACKAGE}@0.17.2 failed: npm error code EACCES\nnpm error permission denied\nThe trierarch keeps running 0.17.1. Fix what npm says, then run aeolus-trierarch upgrade again.`,
    );
    expect(steps).toEqual([]);
  });

  it('stops before it installs when npm\'s global folder is not the user\'s to write, saying exactly what to run instead (#480)', async () => {
    isGlobalFolderWritable = false;

    await expect(upgrade()).rejects.toThrow(
      `npm's global folder /usr/local/lib/node_modules is not yours to write: a system Node install owns it. Run instead:\n  sudo npm install --global ${PACKAGE}@0.17.2\n  aeolus-trierarch install\nThe trierarch keeps running 0.17.1.`,
    );
    expect(installs).toEqual([]);
    expect(steps).toEqual([]);
  });

  it('says only the install to run instead when npm\'s global folder is not the user\'s to write and the service is not installed (#480)', async () => {
    isGlobalFolderWritable = false;
    isServiceInstalled = false;

    await expect(upgrade()).rejects.toThrow(
      `npm's global folder /usr/local/lib/node_modules is not yours to write: a system Node install owns it. Run instead:\n  sudo npm install --global ${PACKAGE}@0.17.2\nThe trierarch keeps running 0.17.1.`,
    );
    expect(installs).toEqual([]);
  });

  it('says to run upgrade at the version after the install, before install restarts the service, when the configuration offers a harness (#718)', async () => {
    isGlobalFolderWritable = false;
    offered = ['codex'];

    await expect(upgrade()).rejects.toThrow(
      `npm's global folder /usr/local/lib/node_modules is not yours to write: a system Node install owns it. Run instead:\n  sudo npm install --global ${PACKAGE}@0.17.2\n  aeolus-trierarch upgrade 0.17.2\n  aeolus-trierarch install\naeolus-trierarch upgrade 0.17.2 updates the aeolus plugin to 0.17.2. The trierarch keeps running 0.17.1.`,
    );
    expect(steps).toEqual([]);
  });

  it('ends with the aeolus plugin of the new version once the commands it says to run instead have run (#718)', async () => {
    isGlobalFolderWritable = false;
    offered = ['codex', 'claude-code'];
    installed = '0.23.0';
    latest = '0.24.0';

    const refusal = await upgrade().then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    const commands = refusal.split('\n').filter((line) => line.startsWith('  ')).map((line) => line.trim());
    for (const command of commands) {
      if (command.startsWith('sudo npm install --global ')) {
        // The user's sudo install, which upgrade never runs itself.
        installed = command.slice(command.lastIndexOf('@') + 1);
      } else if (command.startsWith('aeolus-trierarch upgrade ')) {
        await upgrade(command.slice('aeolus-trierarch upgrade '.length));
      }
    }

    expect(installed).toBe('0.24.0');
    expect(pluginTags).toEqual({ codex: 'v0.24.0', 'claude-code': 'v0.24.0' });
  });

  it('restarts the service on the version installed when it is on that version already but the service still runs another, as after an install by hand (#829)', async () => {
    installed = '0.17.2';
    latest = '0.17.2';
    saying = [{ pid: 1, version: '0.17.1' }, { pid: 2, version: '0.17.2' }];

    const report = await upgrade();

    expect(installs).toEqual([]);
    expect(steps).toEqual(['write 0.17.2', 'reload', 'stop 0.17.2', 'start 0.17.2']);
    expect(report.said).toEqual(['The trierarch is already on 0.17.2.', 'The service ran 0.17.1, so it restarted on 0.17.2.', 'The service runs 0.17.2 now. Its sessions kept running: the new process takes them over.']);
  });

  it('runs the version the commands it says to run instead installed, once they have run, when npm\'s global folder is not the user\'s to write (#829)', async () => {
    isGlobalFolderWritable = false;
    offered = ['claude-code'];
    saying = [{ pid: 1, version: '0.17.1' }];

    const refusal = await upgrade().then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    for (const command of refusal.split('\n').filter((line) => line.startsWith('  ')).map((line) => line.trim())) {
      if (command.startsWith('sudo npm install --global ')) {
        installed = command.slice(command.lastIndexOf('@') + 1);
        saying = [{ pid: 1, version: '0.17.1' }, { pid: 2, version: '0.17.2' }];
        reads = 0;
      } else if (command.startsWith('aeolus-trierarch upgrade ')) {
        await upgrade(command.slice('aeolus-trierarch upgrade '.length));
      }
    }

    expect(steps).toContain('start 0.17.2');
  });

  it('leaves the restart to the upgrade it runs the plugin step for, which restarts the service itself (#829, #725)', async () => {
    installed = '0.17.2';
    latest = '0.17.2';
    saying = [{ pid: 1, version: '0.17.1' }];

    const report = await upgrade('0.17.2', { isPluginStepOfAnUpgrade: true });

    expect(steps).toEqual([]);
    expect(report.said).toEqual(['The trierarch is already on 0.17.2.']);
  });

  it('restarts the service once in an upgrade whose installed version runs the plugin step (#829, #725)', async () => {
    offered = ['claude-code'];
    saying = [{ pid: 1, version: '0.17.1' }, { pid: 2, version: '0.17.2' }];
    upgradeInstalledPlugin = async (version) => {
      const report = await upgrade(version, { isPluginStepOfAnUpgrade: true });
      return { status: 0, stdout: JSON.stringify(report), stderr: '' };
    };

    await upgrade();

    expect(steps.filter((step) => step.startsWith('start'))).toEqual(['start 0.17.2']);
  });

  it("runs the aeolus plugin step of the version it installed, not the one of the version it replaces (#725)", async () => {
    offered = ['codex'];
    upgradeInstalledPlugin = (version) => {
      steps.push(`plugin step of ${installed} at ${version}`);
      return Promise.resolve({ status: 0, stdout: JSON.stringify({ from: version, to: version, isUpgraded: false, isPluginUpdated: true, said: [`The trierarch is already on ${version}.`, 'Updated the aeolus plugin for Codex from 0.21.0 to 0.17.2.'] }), stderr: '' });
    };

    const report = await upgrade();

    expect(steps).toEqual(['plugin step of 0.17.2 at 0.17.2', 'write 0.17.2', 'reload', 'stop 0.17.2', 'start 0.17.2']);
    expect(report.said).toEqual(expect.arrayContaining(['Updated the aeolus plugin for Codex from 0.21.0 to 0.17.2.']));
    expect(report.said).not.toContain('The trierarch is already on 0.17.2.');
    expect(report.isPluginUpdated).toBe(true);
  });

  it('says the aeolus plugin was not updated when the version it installed says so (#725)', async () => {
    offered = ['codex'];
    upgradeInstalledPlugin = (version) =>
      Promise.resolve({ status: 1, stdout: JSON.stringify({ from: version, to: version, isUpgraded: false, isPluginUpdated: false, said: [`The trierarch is already on ${version}.`, 'The aeolus plugin for Codex was not updated: offline.'] }), stderr: '' });

    const report = await upgrade();

    expect(report.isPluginUpdated).toBe(false);
    expect(report.said).toContain('The aeolus plugin for Codex was not updated: offline.');
  });

  it('says the aeolus plugin was not updated, and goes on with the restart, when the version it installed answers no report (#725)', async () => {
    offered = ['codex'];
    upgradeInstalledPlugin = () => Promise.resolve({ status: 1, stdout: '', stderr: 'node: bad option\n' });

    const report = await upgrade();

    expect(report.isPluginUpdated).toBe(false);
    expect(report.said).toContain('The aeolus plugin was not updated: the trierarch 0.17.2 said node: bad option. Fix what it says, then run aeolus-trierarch upgrade again.');
    expect(steps).toEqual(['write 0.17.2', 'reload', 'stop 0.17.2', 'start 0.17.2']);
  });

  it('hands no plugin step to the version it installed when the configuration offers no harness (#725)', async () => {
    upgradeInstalledPlugin = (version) => {
      steps.push(`plugin step at ${version}`);
      return Promise.resolve({ status: 0, stdout: '', stderr: '' });
    };

    await upgrade();

    expect(steps).not.toContain('plugin step at 0.17.2');
  });

  it('refuses a version that is no MAJOR.MINOR.PATCH', async () => {
    await expect(upgrade('latest')).rejects.toThrow('latest is no version: give one such as 0.17.2');
    expect(installs).toEqual([]);
  });

  it('installs without touching a service that is not installed, and says how to install it', async () => {
    isServiceInstalled = false;

    const report = await upgrade();

    expect(installs).toEqual([`${PACKAGE}@0.17.2`]);
    expect(steps).toEqual([]);
    expect(report.said.join('\n')).toContain('The service is not installed: run aeolus-trierarch install');
  });

  it('waits for the new process to say its version before it reports, so the status that follows shows it running (#376)', async () => {
    saying = [{ pid: 1, version: '0.17.1' }, undefined, { pid: 2, version: '0.17.2' }];

    const report = await upgrade();

    expect(reads).toBe(3);
    expect(waits).toEqual([1000, 1000]);
    expect(report.said.join('\n')).toContain('The service runs 0.17.2 now.');
  });

  it('takes running.json as the new process\'s only once its pid is the one the service runs, as every start waits (#466)', async () => {
    saying = [{ pid: 1, version: '0.17.2' }, { pid: 2, version: '0.17.2' }];

    const report = await upgrade();

    expect(reads).toBe(2);
    expect(report.said.join('\n')).toContain('The service runs 0.17.2 now.');
  });

  it('stops waiting after 30 seconds when the new process has not said its version, and says so without telling to restart it (#376)', async () => {
    saying = [{ pid: 1, version: '0.17.1' }];

    const report = await upgrade();

    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBe(30_000);
    expect(report.said.join('\n')).toContain(
      'The service started 0.17.2, but the new process has not said its version after 30 seconds: aeolus-trierarch status shows the version it runs once it does.',
    );
    expect(report.said.join('\n')).not.toContain('The service runs 0.17.2 now.');
  });

  it('does not wait for a version when the service is not installed (#376)', async () => {
    isServiceInstalled = false;

    await upgrade();

    expect(reads).toBe(0);
  });

  it('updates the aeolus plugin for each harness the configuration offers before it restarts the service, so the new process starts with it (#581)', async () => {
    offered = ['claude-code', 'codex'];

    await upgrade();

    expect(steps).toEqual(['update claude-code', 'update codex', 'trust codex hooks', 'write 0.17.2', 'reload', 'stop 0.17.2', 'start 0.17.2']);
  });

  it("trusts the aeolus plugin's new or changed hooks in Codex after the update, so a new Codex session starts without a prompt (#581)", async () => {
    offered = ['codex'];

    const report = await upgrade();

    expect(steps.slice(0, 2)).toEqual(['update codex', 'trust codex hooks']);
    expect(report.said).toContain("Codex trusts the aeolus plugin's 1 new or changed hooks.");
  });

  it("trusts no Codex hooks when the configuration does not offer Codex (#581)", async () => {
    offered = ['claude-code'];

    await upgrade();

    expect(steps).not.toContain('trust codex hooks');
  });

  it('says the version each harness had the aeolus plugin on and the one it has now, and that running Codex sessions keep theirs (#581)', async () => {
    offered = ['claude-code', 'codex'];

    const report = await upgrade();

    expect(report.said).toContain('Updated the aeolus plugin for Claude Code from 0.21.0 to 0.22.0.');
    expect(report.said).toContain('Updated the aeolus plugin for Codex from 0.21.0 to 0.22.0. Running Codex sessions keep the version they started with.');
    expect(report.isPluginUpdated).toBe(true);
  });

  it('says the aeolus plugin is on its version already when the update brings none (#581)', async () => {
    offered = ['codex'];
    isPluginLatest = true;

    const report = await upgrade();

    expect(report.said).toContain('The aeolus plugin for Codex is on 0.21.0 already.');
  });

  it('installs the aeolus plugin of the version it upgrades to, from that release tag, for each harness (#652)', async () => {
    offered = ['claude-code', 'codex'];

    await upgrade('0.23.0');

    expect(pluginTags).toEqual({ 'claude-code': 'v0.23.0', codex: 'v0.23.0' });
  });

  it('installs the aeolus plugin of the latest version on npm from its release tag when no version is given (#652)', async () => {
    latest = '0.24.1';
    offered = ['codex'];

    await upgrade();

    expect(pluginTags).toEqual({ codex: 'v0.24.1' });
  });

  it('installs the aeolus plugin of the version the trierarch is on already from its release tag (#652)', async () => {
    installed = '0.23.0';
    offered = ['claude-code'];

    const report = await upgrade('0.23.0');

    expect(report.isUpgraded).toBe(false);
    expect(pluginTags).toEqual({ 'claude-code': 'v0.23.0' });
  });

  it('installs the aeolus plugin from main for a version up to 0.22.0, whose release tag holds no plugin of its version, and says so (#652)', async () => {
    offered = ['claude-code', 'codex'];

    const report = await upgrade('0.22.0');

    expect(pluginTags).toEqual({ 'claude-code': undefined, codex: undefined });
    expect(report.said).toContain('Releases up to 0.22.0 tag no aeolus plugin of their version: the plugin comes from main, the latest released one.');
  });

  it('says plainly on a Codex downgrade that new Codex sessions keep starting on the newer plugin, kept for the sessions running on it (#652)', async () => {
    offered = ['codex'];
    pluginVersions = { codex: '0.24.0' };
    isPluginLatest = true;

    const report = await upgrade('0.23.0');

    expect(report.said).toContain('New Codex sessions keep starting on the aeolus plugin 0.24.0, not on 0.23.0: Codex starts on the newest version it has, and 0.24.0 stays for the Codex sessions running on it.');
  });

  it('says no such thing when Codex has the aeolus plugin of the version (#652)', async () => {
    offered = ['codex'];
    pluginVersions = { codex: '0.23.0' };
    isPluginLatest = true;

    const report = await upgrade('0.23.0');

    expect(report.said.join('\n')).not.toContain('New Codex sessions');
  });

  it('says no such thing for Claude Code, which starts on the version it installed (#652)', async () => {
    offered = ['claude-code'];
    pluginVersions = { 'claude-code': '0.24.0' };
    isPluginLatest = true;

    const report = await upgrade('0.23.0');

    expect(report.said.join('\n')).not.toContain('sessions keep starting');
  });

  it('says nothing of main when the release tag holds the aeolus plugin (#652)', async () => {
    offered = ['codex'];

    const report = await upgrade('0.23.0');

    expect(report.said.join('\n')).not.toContain('from main');
  });

  it('updates the aeolus plugin also when the trierarch is on the version already (#581)', async () => {
    latest = '0.17.1';
    saying = [{ pid: 2, version: '0.17.1' }];
    offered = ['codex'];

    const report = await upgrade();

    expect(steps).toEqual(['update codex', 'trust codex hooks']);
    expect(report).toMatchObject({ isUpgraded: false, isPluginUpdated: true });
    expect(report.said[0]).toBe('The trierarch is already on 0.17.1.');
  });

  it("says a failed plugin update and goes on with the trierarch's upgrade and the other harnesses (#581)", async () => {
    offered = ['codex', 'claude-code'];
    failingPluginUpdate = 'codex';

    const report = await upgrade();

    expect(steps).toEqual(['update codex', 'update claude-code', 'write 0.17.2', 'reload', 'stop 0.17.2', 'start 0.17.2']);
    expect(report.isPluginUpdated).toBe(false);
    expect(report.said).toContain(
      'The aeolus plugin for Codex was not updated: codex plugin marketplace upgrade aeolus-fleet failed: could not reach github.com. It stays on 0.21.0; fix what it says, then run aeolus-trierarch upgrade again.',
    );
  });

  it("says when Codex's hooks could not be trusted after the update, as a failed plugin update (#581)", async () => {
    offered = ['codex'];
    isHookTrustFailing = true;

    const report = await upgrade();

    expect(report.isPluginUpdated).toBe(false);
    expect(report.said).toContain(
      "Codex does not trust the aeolus plugin's hooks yet: codex app-server ended before it answered (exit 1). Each Codex launch trusts them first, and starts no session while they cannot be; fix what it says, then run aeolus-trierarch upgrade again.",
    );
  });

  it('leaves the aeolus plugin as it is when the trierarch cannot be installed (#581)', async () => {
    offered = ['codex'];
    failing = { status: 1, stdout: '', stderr: 'npm error code EACCES\n' };

    await expect(upgrade()).rejects.toThrow('npm install --global');
    expect(steps).toEqual([]);
  });
});
