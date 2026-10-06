import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TrierarchPaths } from '../adapters/paths.js';
import { runCommand } from '../adapters/run-command.js';

/**
 * `aeolus-trierarch install`: keeps `aeolus-trierarch run` alive under the
 * operating system, started at login and again whenever it stops. A launchd
 * agent on macOS, a systemd user unit on Linux.
 */

export const LAUNCHD_LABEL = 'dev.aeolus-fleet.trierarch';
export const SYSTEMD_UNIT = 'aeolus-trierarch.service';

/** What runs the trierarch: this Node and this command's own file. */
export interface RunCommand {
  readonly node: string;
  readonly script: string;
}

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function launchdPlist(at: { run: RunCommand; paths: TrierarchPaths; path: string }): string {
  const strings = (values: readonly string[]) => values.map((value) => `    <string>${escapeXml(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings([at.run.node, at.run.script, 'run'])}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(at.path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(at.paths.logs, 'trierarch.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(at.paths.logs, 'trierarch.log'))}</string>
</dict>
</plist>
`;
}

export function systemdUnit(at: { run: RunCommand; path: string }): string {
  return `[Unit]
Description=Aeolus trierarch: keeps the ships on its wanted list crewed on this machine

[Service]
ExecStart="${at.run.node}" "${at.run.script}" run
Environment="PATH=${at.path}"
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export async function install(input: {
  platform: string;
  homeDirectory: string;
  paths: TrierarchPaths;
  run: RunCommand;
  path: string;
  /** Write the file only, without loading it: for a test, or to load it by hand. */
  isLoading: boolean;
  uid: number;
}): Promise<string[]> {
  const { platform, homeDirectory, paths, run, path, isLoading, uid } = input;
  await mkdir(paths.logs, { recursive: true });
  if (platform === 'darwin') {
    const plist = join(homeDirectory, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    await mkdir(join(homeDirectory, 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(plist, launchdPlist({ run, paths, path }));
    if (!isLoading) {
      return [`Wrote ${plist}. Load it with: launchctl bootstrap gui/${String(uid)} ${plist}`];
    }
    await runCommand('launchctl', { args: ['bootout', `gui/${String(uid)}/${LAUNCHD_LABEL}`] });
    const loaded = await runCommand('launchctl', { args: ['bootstrap', `gui/${String(uid)}`, plist] });
    if (loaded.status !== 0) {
      throw new Error(`launchctl bootstrap failed: ${loaded.stderr.trim()}`);
    }
    return [`Installed ${plist}: the trierarch runs now, and again at every login. Logs: ${paths.logs}`];
  }
  if (platform === 'linux') {
    const folder = join(homeDirectory, '.config', 'systemd', 'user');
    const unit = join(folder, SYSTEMD_UNIT);
    await mkdir(folder, { recursive: true });
    await writeFile(unit, systemdUnit({ run, path }));
    if (!isLoading) {
      return [`Wrote ${unit}. Start it with: systemctl --user enable --now ${SYSTEMD_UNIT}`];
    }
    const started = await runCommand('systemctl', { args: ['--user', 'enable', '--now', SYSTEMD_UNIT] });
    if (started.status !== 0) {
      throw new Error(`systemctl --user enable failed: ${started.stderr.trim()}`);
    }
    return [`Installed ${unit}: the trierarch runs now, and again at every login.`];
  }
  throw new Error(`aeolus-trierarch install knows launchd (macOS) and systemd (Linux), not ${platform}: run aeolus-trierarch run under your own supervisor`);
}
