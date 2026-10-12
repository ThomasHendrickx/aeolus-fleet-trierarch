import type { TrierarchConfiguration } from '@aeolus-fleet/common';
import { beforeEach, describe, expect, it } from 'vitest';

import { CONFIGURATION, InMemoryContainerHost } from '../../test/support/in-memory.js';
import { createCheckSessionRuntime } from './check-session-runtime.js';

const MODEL_TOKEN_FILE = '/home/thomas/.aeolus/trierarch/model-token';
const CONTAINER = { kind: 'container', binary: 'podman', memory: '4g', cpus: 2 } as const;

/** A machine that runs its sessions in containers, with Claude Code launched without Remote Control. */
function inContainers(overrides: Partial<TrierarchConfiguration> = {}): TrierarchConfiguration {
  return { ...CONFIGURATION, runtime: CONTAINER, harnesses: { 'claude-code': { flags: ['--dangerously-skip-permissions'], options: {} } }, ...overrides };
}

let host: InMemoryContainerHost;
const check = (configuration: TrierarchConfiguration) => createCheckSessionRuntime({ host, modelTokenFile: MODEL_TOKEN_FILE })(configuration);

beforeEach(() => {
  host = new InMemoryContainerHost();
});

describe('checking the session runtime (decision 0039)', () => {
  it('takes a rootless runtime, a user in no docker group, Claude Code without Remote Control and the model token written', async () => {
    await expect(check(inContainers())).resolves.toEqual([]);
  });

  it('asks nothing of the machine for sessions on the host, Remote Control and Codex included', async () => {
    const configuration = { ...CONFIGURATION, harnesses: { 'claude-code': { flags: ['--remote-control'], options: {} }, codex: { flags: [], options: {} } } };
    host.mode = 'rootful';
    host.hasModelToken = false;

    expect({ refusals: await check(configuration), asked: host.asked }).toEqual({ refusals: [], asked: [] });
  });

  it('asks the binary the configuration names', async () => {
    await check(inContainers({ runtime: { ...CONTAINER, binary: '/usr/local/bin/podman' } }));

    expect(host.asked).toEqual(['/usr/local/bin/podman']);
  });

  it('refuses a rootful runtime, which holds the host as root', async () => {
    host.mode = 'rootful';

    await expect(check(inContainers())).resolves.toEqual(['podman runs rootful: the container runtime runs rootless only, as the user that runs the trierarch']);
  });

  it('refuses a runtime that does not answer', async () => {
    host.mode = 'missing';

    await expect(check(inContainers())).resolves.toEqual(['podman does not answer: install a rootless podman, or name the runtime binary in runtime.binary']);
  });

  it('refuses a user in the docker group, which is root on the machine', async () => {
    host.groups = ['thomas', 'sudo', 'docker'];

    await expect(check(inContainers())).resolves.toEqual(['the user that runs the trierarch is in the docker group, which is root on the machine: take the user out of it']);
  });

  it('refuses --remote-control in a harness flags, as a container session has no Remote Control', async () => {
    await expect(check(inContainers({ harnesses: { 'claude-code': { flags: ['--remote-control'], options: {} } } }))).resolves.toEqual([
      'claude-code launches with --remote-control: a session in a container has no Remote Control, so remove it',
    ]);
  });

  it('refuses --remote-control with a name of its own', async () => {
    await expect(check(inContainers({ harnesses: { 'claude-code': { flags: ['--remote-control=lookout'], options: {} } } }))).resolves.toHaveLength(1);
  });

  it('refuses --remote-control in the flags of an option value', async () => {
    const harnesses = { 'claude-code': { flags: [], options: { remote: { values: { on: ['--remote-control'], off: [] }, default: 'off' } } } };

    await expect(check(inContainers({ harnesses }))).resolves.toEqual(['claude-code launches with --remote-control: a session in a container has no Remote Control, so remove it']);
  });

  it('refuses Codex, which is not proven in a container yet', async () => {
    const harnesses = { 'claude-code': { flags: [], options: {} }, codex: { flags: [], options: {} } };

    await expect(check(inContainers({ harnesses }))).resolves.toEqual(['codex does not run in a container yet: the container runtime offers claude-code only, so remove codex']);
  });

  it('refuses a machine whose model token file is missing or empty', async () => {
    host.hasModelToken = false;

    await expect(check(inContainers())).resolves.toEqual([
      `the model token file ${MODEL_TOKEN_FILE} is missing or empty: write the token claude setup-token gives into it, readable by its owner only`,
    ]);
  });

  it('gives every refusal at once', async () => {
    host.mode = 'rootful';
    host.groups = ['docker'];
    host.hasModelToken = false;

    await expect(check(inContainers({ harnesses: { 'claude-code': { flags: ['--remote-control'], options: {} }, codex: { flags: [], options: {} } } }))).resolves.toHaveLength(5);
  });
});
