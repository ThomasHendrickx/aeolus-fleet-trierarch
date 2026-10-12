import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rootlessPodman } from '../../test/support/podman.js';
import { createContainerHost } from './container-host.js';
import { runCommand, type CommandResult } from './run-command.js';

const podman = await rootlessPodman({ platform: process.platform, info: () => runCommand('podman', { args: ['info', '--format', '{{.Host.Security.Rootless}}'] }) });

let folder: string;
let modelTokenFile: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'trierarch-container-host-'));
  modelTokenFile = join(folder, 'model-token');
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

/** A runner that answers each program with what the test gives it. */
function answering(answers: Readonly<Record<string, CommandResult>>) {
  return (command: string): Promise<CommandResult> => Promise.resolve(answers[command] ?? { status: 127, stdout: '', stderr: `${command}: not found` });
}

const info = (body: unknown): CommandResult => ({ status: 0, stdout: JSON.stringify(body), stderr: '' });

describe('the machine as the container runtime checks read it', () => {
  it('reads a rootless Podman from its info', async () => {
    const host = createContainerHost({ modelTokenFile, run: answering({ podman: info({ host: { security: { rootless: true } } }) }) });

    await expect(host.runtimeMode('podman')).resolves.toBe('rootless');
  });

  it('reads a Podman run as root from its info', async () => {
    const host = createContainerHost({ modelTokenFile, run: answering({ podman: info({ host: { security: { rootless: false } } }) }) });

    await expect(host.runtimeMode('podman')).resolves.toBe('rootful');
  });

  it('reads a rootless docker from the security options its info lists', async () => {
    const host = createContainerHost({ modelTokenFile, run: answering({ docker: info({ SecurityOptions: ['name=seccomp,profile=default', 'name=rootless'] }) }) });

    await expect(host.runtimeMode('docker')).resolves.toBe('rootless');
  });

  it('reads a docker daemon run as root from its info', async () => {
    const host = createContainerHost({ modelTokenFile, run: answering({ docker: info({ SecurityOptions: ['name=seccomp,profile=default'] }) }) });

    await expect(host.runtimeMode('docker')).resolves.toBe('rootful');
  });

  it('reads a runtime whose info fails as missing', async () => {
    const host = createContainerHost({ modelTokenFile, run: answering({ podman: { status: 125, stdout: '', stderr: 'cannot connect' } }) });

    await expect(host.runtimeMode('podman')).resolves.toBe('missing');
  });

  it('reads a binary that is not there as missing', async () => {
    await expect(createContainerHost({ modelTokenFile }).runtimeMode(join(folder, 'no-podman'))).resolves.toBe('missing');
  });

  it("reads the user's groups by name", async () => {
    const host = createContainerHost({ modelTokenFile, run: answering({ id: { status: 0, stdout: 'thomas sudo docker\n', stderr: '' } }) });

    await expect(host.userGroups()).resolves.toEqual(['thomas', 'sudo', 'docker']);
  });

  it('reads a model token written in its file', async () => {
    writeFileSync(modelTokenFile, 'sk-ant-oat01-test-token\n', { mode: 0o600 });

    await expect(createContainerHost({ modelTokenFile }).isModelTokenWritten()).resolves.toBe(true);
  });

  it('reads no model token without its file', async () => {
    await expect(createContainerHost({ modelTokenFile }).isModelTokenWritten()).resolves.toBe(false);
  });

  it('reads no model token from a file with only blank lines', async () => {
    writeFileSync(modelTokenFile, '\n \n', { mode: 0o600 });

    await expect(createContainerHost({ modelTokenFile }).isModelTokenWritten()).resolves.toBe(false);
  });

  it('reads the rootless Podman of this machine as rootless', async (context) => {
    if (!podman.isUsable) {
      context.skip(podman.reason);
    }

    await expect(createContainerHost({ modelTokenFile }).runtimeMode('podman')).resolves.toBe('rootless');
  });
});
