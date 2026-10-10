import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { trierarchPaths } from './paths.js';
import { runCommand } from './run-command.js';
import { createService, serviceEnvironment, SYSTEMD_UNIT } from './service.js';

// The unit the trierarch writes, run by the real systemd user manager under a
// name of the test's own, so the machine's own trierarch is left alone. Its
// command starts a tmux server the way the trierarch starts its sessions. Runs
// only where a systemd user manager answers (a Linux desktop or host, not CI).

const hasUserSystemd = process.platform === 'linux' && (await runCommand('systemctl', { args: ['--user', 'is-system-running'] }).catch(() => ({ status: 1 }))).status === 0;

const SESSION_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 60_000;

let folder: string;
let name: string;
let server: string;
let unitFile: string;

const systemctl = (...args: string[]) => runCommand('systemctl', { args: ['--user', ...args] });
/** The tmux server's pid, so a server the restarted command starts anew is told apart from the one kept. */
const serverPid = async () => (await runCommand('tmux', { args: ['-L', server, 'display-message', '-p', '-t', 'session', '#{pid}'] })).stdout.trim();

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'trierarch-systemd-'));
  const suffix = folder.slice(-6).toLowerCase().replaceAll(/[^a-z0-9]/g, 'x');
  name = `aeolus-trierarch-test-${suffix}.service`;
  server = `trierarch-systemd-${suffix}`;
  unitFile = join(homedir(), '.config', 'systemd', 'user', name);
});

afterEach(async () => {
  await systemctl('stop', name);
  rmSync(unitFile, { force: true });
  await systemctl('daemon-reload');
  await runCommand('tmux', { args: ['-L', server, 'kill-server'] });
  rmSync(folder, { recursive: true, force: true });
});

describe.runIf(hasUserSystemd)('the systemd user unit on this machine', () => {
  it(
    'keeps the sessions in the tmux server the trierarch started running across a stop and a restart of the service (#479)',
    async () => {
      const script = join(folder, 'trierarch.sh');
      writeFileSync(script, `tmux -L ${server} new-session -d -s session sleep 300\nexec sleep 300\n`);
      await createService({
        platform: 'linux',
        homeDirectory: folder,
        paths: trierarchPaths({ homeDirectory: folder }),
        run: { node: '/bin/sh', script },
        environment: serviceEnvironment(process.env),
        uid: process.getuid?.() ?? 0,
        exec: (command, args) => runCommand(command, { args }),
        now: () => new Date(),
      }).write();
      writeFileSync(unitFile, readFileSync(join(folder, '.config', 'systemd', 'user', SYSTEMD_UNIT), 'utf8'));
      await systemctl('daemon-reload');
      await systemctl('start', name);
      await expect.poll(serverPid, { timeout: SESSION_TIMEOUT_MS }).not.toBe('');
      const started = await serverPid();

      await systemctl('restart', name);
      const afterRestart = await serverPid();
      await systemctl('stop', name);

      expect({ afterRestart, afterStop: await serverPid() }).toEqual({ afterRestart: started, afterStop: started });
    },
    TEST_TIMEOUT_MS,
  );
});
