import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { trierarchPaths } from './paths.js';
import type { CommandResult } from './run-command.js';
import { createService, LAUNCHD_LABEL, serviceEnvironment, SYSTEMD_UNIT, type Service } from './service.js';

let home: string;
let calls: string[];
let answers: Map<string, CommandResult>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'trierarch-service-'));
  calls = [];
  answers = new Map();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const run = { node: '/opt/homebrew/bin/node', script: '/opt/homebrew/lib/node_modules/@aeolus-fleet/trierarch/dist/bin/aeolus-trierarch.js' };
const environment = { PATH: '/opt/homebrew/bin:/usr/bin:/bin', AEOLUS_PLUGIN_ROOT: '/Users/thomas/aeolus-fleet/plugins/aeolus' };
const NOW = new Date('2026-10-06T10:00:00.000Z');
const ok = (stdout = ''): CommandResult => ({ status: 0, stdout, stderr: '' });

function serviceOn(platform: string): Service {
  return createService({
    platform,
    homeDirectory: home,
    paths: trierarchPaths({ homeDirectory: home }),
    run,
    environment,
    uid: 501,
    now: () => NOW,
    exec: (command, args) => {
      const line = [command, ...args].join(' ');
      calls.push(line);
      return Promise.resolve(answers.get(line) ?? { status: 1, stdout: '', stderr: 'not loaded' });
    },
  });
}

const plist = () => join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const unit = () => join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT);
const target = `gui/501/${LAUNCHD_LABEL}`;

describe('the service on macOS (launchd)', () => {
  it('installs an agent that runs the trierarch at login and again whenever it stops, logging under ~/.aeolus/trierarch/logs, and loads it', async () => {
    answers.set(`launchctl bootstrap gui/501 ${plist()}`, ok());

    await serviceOn('darwin').install();

    const text = readFileSync(plist(), 'utf8');
    expect(text).toContain(`<string>${run.node}</string>\n    <string>${run.script}</string>\n    <string>run</string>`);
    expect(text).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(text).toContain('<key>KeepAlive</key>\n  <true/>');
    expect(text).toContain(`<string>${join(home, '.aeolus', 'trierarch', 'logs', 'trierarch.log')}</string>`);
    expect(text).toContain('<key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/bin:/bin</string>');
    expect(text).toContain('<key>AEOLUS_PLUGIN_ROOT</key>\n    <string>/Users/thomas/aeolus-fleet/plugins/aeolus</string>');
    expect(calls).toEqual([`launchctl bootout ${target}`, `launchctl bootstrap gui/501 ${plist()}`]);
  });

  it('says why when launchd refuses to load it', async () => {
    await expect(serviceOn('darwin').install()).rejects.toThrow('launchctl bootstrap failed: not loaded');
  });

  it('is not installed before install', async () => {
    await expect(serviceOn('darwin').status()).resolves.toEqual({ file: plist(), isInstalled: false, isRunning: false });
  });

  it('runs with its pid and since when it started, as launchd and ps say', async () => {
    answers.set(`launchctl bootstrap gui/501 ${plist()}`, ok());
    answers.set(`launchctl print ${target}`, ok(`${target} = {\n\tstate = running\n\tpid = 4242\n}`));
    answers.set('ps -o etime= -p 4242', ok('  1-02:03:04\n'));
    const service = serviceOn('darwin');
    await service.install();

    await expect(service.status()).resolves.toEqual({ file: plist(), isInstalled: true, isRunning: true, pid: 4242, since: '2026-10-05T07:56:56.000Z' });
  });

  it('is installed but not running when launchd has it unloaded', async () => {
    answers.set(`launchctl bootstrap gui/501 ${plist()}`, ok());
    const service = serviceOn('darwin');
    await service.install();

    await expect(service.status()).resolves.toEqual({ file: plist(), isInstalled: true, isRunning: false });
  });

  it('stops by unloading the agent, so KeepAlive does not start it again', async () => {
    await serviceOn('darwin').stop();

    expect(calls).toEqual([`launchctl bootout ${target}`, `launchctl print ${target}`]);
  });

  it('says stopped only once launchd has the agent gone, as bootout returns before the process exits', async () => {
    answers.set(`launchctl print ${target}`, ok('state = running'));
    let waits = 0;
    const service = createService({
      platform: 'darwin',
      homeDirectory: home,
      paths: trierarchPaths({ homeDirectory: home }),
      run,
      environment,
      uid: 501,
      now: () => NOW,
      sleep: () => {
        waits += 1;
        if (waits === 3) {
          answers.delete(`launchctl print ${target}`);
        }
        return Promise.resolve();
      },
      exec: (command, args) => {
        const line = [command, ...args].join(' ');
        calls.push(line);
        return Promise.resolve(answers.get(line) ?? { status: 1, stdout: '', stderr: 'not loaded' });
      },
    });

    await service.stop();

    expect(waits).toBe(3);
    expect(calls.filter((line) => line === `launchctl print ${target}`)).toHaveLength(4);
  });

  it('says why when the agent is still there long after it was stopped', async () => {
    answers.set(`launchctl print ${target}`, ok('state = running'));
    const service = createService({
      platform: 'darwin',
      homeDirectory: home,
      paths: trierarchPaths({ homeDirectory: home }),
      run,
      environment,
      uid: 501,
      now: () => NOW,
      sleep: () => Promise.resolve(),
      exec: (command, args) => Promise.resolve(answers.get([command, ...args].join(' ')) ?? { status: 1, stdout: '', stderr: '' }),
    });

    await expect(service.stop()).rejects.toThrow('The trierarch still runs 30 s after it was stopped');
  });

  it('starts by loading the agent when it is unloaded, and by kicking it when it is loaded', async () => {
    answers.set(`launchctl bootstrap gui/501 ${plist()}`, ok());
    const service = serviceOn('darwin');
    await service.install();
    calls = [];

    await service.start();
    answers.set(`launchctl print ${target}`, ok('state = waiting'));
    answers.set(`launchctl kickstart ${target}`, ok());
    await service.start();

    expect(calls).toEqual([`launchctl print ${target}`, `launchctl bootstrap gui/501 ${plist()}`, `launchctl print ${target}`, `launchctl kickstart ${target}`]);
  });

  it('restarts by killing and starting it again', async () => {
    answers.set(`launchctl bootstrap gui/501 ${plist()}`, ok());
    answers.set(`launchctl print ${target}`, ok('state = running'));
    answers.set(`launchctl kickstart -k ${target}`, ok());
    const service = serviceOn('darwin');
    await service.install();
    calls = [];

    await service.restart();

    expect(calls).toEqual([`launchctl print ${target}`, `launchctl kickstart -k ${target}`]);
  });

  it('refuses to start or restart before install', async () => {
    await expect(serviceOn('darwin').start()).rejects.toThrow('The service is not installed: run aeolus-trierarch install');
    await expect(serviceOn('darwin').restart()).rejects.toThrow('The service is not installed: run aeolus-trierarch install');
  });

  it('uninstalls by unloading the agent and removing its file', async () => {
    answers.set(`launchctl bootstrap gui/501 ${plist()}`, ok());
    const service = serviceOn('darwin');
    await service.install();
    calls = [];

    await service.uninstall();

    expect(calls).toEqual([`launchctl bootout ${target}`]);
    expect(existsSync(plist())).toBe(false);
  });

  it('only writes the file when asked not to load it', async () => {
    await serviceOn('darwin').write();

    expect(existsSync(plist())).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe('the service on Linux (systemd)', () => {
  it('installs a user unit that restarts the trierarch, and enables and starts it', async () => {
    answers.set('systemctl --user daemon-reload', ok());
    answers.set(`systemctl --user enable --now ${SYSTEMD_UNIT}`, ok());

    await serviceOn('linux').install();

    const text = readFileSync(unit(), 'utf8');
    expect(text).toContain(`ExecStart="${run.node}" "${run.script}" run`);
    expect(text).toContain('Restart=always');
    expect(text).toContain('Environment="PATH=/opt/homebrew/bin:/usr/bin:/bin"');
    expect(text).toContain('Environment="AEOLUS_PLUGIN_ROOT=/Users/thomas/aeolus-fleet/plugins/aeolus"');
    expect(calls).toEqual(['systemctl --user daemon-reload', `systemctl --user enable --now ${SYSTEMD_UNIT}`]);
  });

  it('runs with its pid and since when it started, as systemd and ps say', async () => {
    answers.set('systemctl --user daemon-reload', ok());
    answers.set(`systemctl --user enable --now ${SYSTEMD_UNIT}`, ok());
    answers.set(`systemctl --user show ${SYSTEMD_UNIT} -p ActiveState -p MainPID`, ok('ActiveState=active\nMainPID=77\n'));
    answers.set('ps -o etime= -p 77', ok('05:00\n'));
    const service = serviceOn('linux');
    await service.install();

    await expect(service.status()).resolves.toEqual({ file: unit(), isInstalled: true, isRunning: true, pid: 77, since: '2026-10-06T09:55:00.000Z' });
  });

  it('starts, stops and restarts through systemctl', async () => {
    answers.set('systemctl --user daemon-reload', ok());
    answers.set(`systemctl --user enable --now ${SYSTEMD_UNIT}`, ok());
    for (const verb of ['start', 'stop', 'restart']) {
      answers.set(`systemctl --user ${verb} ${SYSTEMD_UNIT}`, ok());
    }
    const service = serviceOn('linux');
    await service.install();
    calls = [];

    await service.start();
    await service.stop();
    await service.restart();

    expect(calls).toEqual([`systemctl --user start ${SYSTEMD_UNIT}`, `systemctl --user stop ${SYSTEMD_UNIT}`, `systemctl --user restart ${SYSTEMD_UNIT}`]);
  });

  it('uninstalls by disabling and stopping the unit, removing its file and reloading', async () => {
    answers.set('systemctl --user daemon-reload', ok());
    answers.set(`systemctl --user enable --now ${SYSTEMD_UNIT}`, ok());
    const service = serviceOn('linux');
    await service.install();
    calls = [];

    await service.uninstall();

    expect(calls).toEqual([`systemctl --user disable --now ${SYSTEMD_UNIT}`, 'systemctl --user daemon-reload']);
    expect(existsSync(unit())).toBe(false);
  });
});

describe('the service elsewhere', () => {
  it('says what it knows on any other platform', async () => {
    await expect(serviceOn('win32').install()).rejects.toThrow('knows launchd (macOS) and systemd (Linux), not win32');
    await expect(serviceOn('win32').status()).rejects.toThrow('knows launchd (macOS) and systemd (Linux), not win32');
  });
});

describe("the service's environment", () => {
  it("gives the service the PATH and the trierarch's own variables set where install ran, and nothing else", () => {
    expect(
      serviceEnvironment({ PATH: '/usr/bin', HOME: '/Users/thomas', AEOLUS_PLUGIN_ROOT: '/plugin', AEOLUS_PLUGIN_DATA: '/data', AEOLUS_TRIERARCH_CONFIG: '/config.json', SECRET: 'x' }),
    ).toEqual({ PATH: '/usr/bin', AEOLUS_PLUGIN_ROOT: '/plugin', AEOLUS_PLUGIN_DATA: '/data', AEOLUS_TRIERARCH_CONFIG: '/config.json' });
  });

  it('gives the service a plain PATH where install ran without one', () => {
    expect(serviceEnvironment({})).toEqual({ PATH: '/usr/bin:/bin' });
  });
});
