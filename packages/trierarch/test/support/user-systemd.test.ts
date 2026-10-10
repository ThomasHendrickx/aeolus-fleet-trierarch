import { describe, expect, it } from 'vitest';

import type { CommandResult } from '../../src/adapters/run-command.js';
import { userSystemd } from './user-systemd.js';

/** `systemctl --user is-system-running` answering a state, with its exit status as systemd gives it. */
const answering = (state: string) => () => Promise.resolve<CommandResult>({ status: state === 'running' ? 0 : 1, stdout: `${state}\n`, stderr: '' });
const missing = () => Promise.reject(new Error('spawn systemctl ENOENT'));

describe('whether the systemd tests can run on this machine', () => {
  it('runs them where the user manager is running', async () => {
    expect(await userSystemd({ platform: 'linux', isSystemRunning: answering('running') })).toEqual({ isUsable: true });
  });

  it('runs them where the user manager is degraded, as a failed unit of its own says nothing of the units the tests start (#552)', async () => {
    expect(await userSystemd({ platform: 'linux', isSystemRunning: answering('degraded') })).toEqual({ isUsable: true });
  });

  it('skips them, saying why, where the user manager is in another state', async () => {
    expect(await userSystemd({ platform: 'linux', isSystemRunning: answering('offline') })).toEqual({ isUsable: false, reason: 'the systemd user manager is offline' });
  });

  it('skips them, saying why, where systemctl does not run', async () => {
    expect(await userSystemd({ platform: 'linux', isSystemRunning: missing })).toEqual({ isUsable: false, reason: 'systemctl --user does not run here: spawn systemctl ENOENT' });
  });

  it('skips them, saying why, off Linux', async () => {
    expect(await userSystemd({ platform: 'darwin', isSystemRunning: answering('running') })).toEqual({ isUsable: false, reason: 'systemd runs on Linux only, not on darwin' });
  });
});
