import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { trierarchPaths } from '../adapters/paths.js';
import { install, LAUNCHD_LABEL, serviceEnvironment, SYSTEMD_UNIT } from './install.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'trierarch-install-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const run = { node: '/opt/homebrew/bin/node', script: '/usr/local/lib/node_modules/@aeolus-fleet/trierarch/dist/bin/aeolus-trierarch.js' };

const environment = { PATH: '/opt/homebrew/bin:/usr/bin:/bin', AEOLUS_PLUGIN_ROOT: '/Users/thomas/aeolus-fleet/plugins/aeolus' };

function installOn(platform: string) {
  return install({ platform, homeDirectory: home, paths: trierarchPaths({ homeDirectory: home }), run, environment, isLoading: false, uid: 501 });
}

describe('aeolus-trierarch install', () => {
  it('writes a launchd agent on macOS that runs the trierarch at login and again whenever it stops, logging under ~/.aeolus/trierarch/logs', async () => {
    const said = await installOn('darwin');

    const plist = readFileSync(join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`), 'utf8');
    expect(plist).toContain(`<string>${run.node}</string>\n    <string>${run.script}</string>\n    <string>run</string>`);
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
    expect(plist).toContain(`<string>${join(home, '.aeolus', 'trierarch', 'logs', 'trierarch.log')}</string>`);
    expect(plist).toContain('<key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/bin:/bin</string>');
    expect(plist).toContain('<key>AEOLUS_PLUGIN_ROOT</key>\n    <string>/Users/thomas/aeolus-fleet/plugins/aeolus</string>');
    expect(said.join('\n')).toContain('launchctl bootstrap gui/501');
  });

  it('writes a systemd user unit on Linux that restarts the trierarch', async () => {
    const said = await installOn('linux');

    const unit = readFileSync(join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT), 'utf8');
    expect(unit).toContain(`ExecStart="${run.node}" "${run.script}" run`);
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('Environment="PATH=/opt/homebrew/bin:/usr/bin:/bin"');
    expect(unit).toContain('Environment="AEOLUS_PLUGIN_ROOT=/Users/thomas/aeolus-fleet/plugins/aeolus"');
    expect(said.join('\n')).toContain(`systemctl --user enable --now ${SYSTEMD_UNIT}`);
  });

  it("gives the service the PATH and the trierarch's own variables set where install ran, and nothing else", () => {
    expect(
      serviceEnvironment({ PATH: '/usr/bin', HOME: '/Users/thomas', AEOLUS_PLUGIN_ROOT: '/plugin', AEOLUS_PLUGIN_DATA: '/data', AEOLUS_TRIERARCH_CONFIG: '/config.json', SECRET: 'x' }),
    ).toEqual({ PATH: '/usr/bin', AEOLUS_PLUGIN_ROOT: '/plugin', AEOLUS_PLUGIN_DATA: '/data', AEOLUS_TRIERARCH_CONFIG: '/config.json' });
  });

  it('gives the service a plain PATH where install ran without one', () => {
    expect(serviceEnvironment({})).toEqual({ PATH: '/usr/bin:/bin' });
  });

  it('says what it knows on any other platform', async () => {
    await expect(installOn('win32')).rejects.toThrow('knows launchd (macOS) and systemd (Linux), not win32');
  });
});
