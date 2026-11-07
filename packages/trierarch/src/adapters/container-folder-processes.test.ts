import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FolderProcessesPort } from '../core/ports.js';
import { createContainerFolderProcesses } from './container-folder-processes.js';
import type { CommandResult } from './run-command.js';

let home: string;
let folder: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'trierarch-container-folder-')));
  folder = join(home, 'aeolus-fleet', 'scout');
  mkdirSync(folder, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** The processes on the host, which stop as many as it is set to, and count each folder they were asked to stop in. */
function hostProcesses(stopped: number): FolderProcessesPort & { readonly asked: string[] } {
  const asked: string[] = [];
  return { asked, stopIn: (at) => Promise.resolve(stopped).finally(() => asked.push(at)) };
}

/** The container runtime, which lists the containers as the answer for the folder a listing filters on says. */
function runtimeListing(answer: (volume: string | undefined) => Partial<CommandResult>) {
  return (_binary: string, options: { args: readonly string[] }): Promise<CommandResult> => {
    const filter = options.args.find((arg) => arg.startsWith('volume='));
    return Promise.resolve({ status: 0, stdout: '', stderr: '', ...(options.args[0] === 'ps' ? answer(filter?.slice('volume='.length)) : {}) });
  };
}

describe('the processes in a folder when sessions run in containers', () => {
  it('stops the processes on the host in a folder no container works in', async () => {
    const host = hostProcesses(2);
    const processes = createContainerFolderProcesses({ binary: 'podman', host, run: runtimeListing(() => ({ stdout: '' })) });

    expect({ stopped: await processes.stopIn(folder), asked: host.asked }).toEqual({ stopped: 2, asked: [folder] });
  });

  it('leaves a folder a container works in for the next pass, saying which, and stops nothing', async () => {
    const host = hostProcesses(2);
    const processes = createContainerFolderProcesses({ binary: 'podman', host, run: runtimeListing((volume) => ({ stdout: volume === folder ? 'trierarch-shp_scout running\n' : '' })) });

    await expect(processes.stopIn(folder)).rejects.toThrow(`A container works in ${folder}, so it is left for the next pass: trierarch-shp_scout`);
    expect(host.asked).toEqual([]);
  });

  it('leaves a folder a container works in by its real path, reached over a link', async () => {
    symlinkSync(home, join(home, '..', `${home.split('/').at(-1) ?? ''}-linked`));
    const linked = join(`${home}-linked`, 'aeolus-fleet', 'scout');
    const processes = createContainerFolderProcesses({ binary: 'podman', host: hostProcesses(0), run: runtimeListing((volume) => ({ stdout: volume === folder ? 'trierarch-shp_scout running\n' : '' })) });

    try {
      await expect(processes.stopIn(linked)).rejects.toThrow('A container works in');
    } finally {
      rmSync(`${home}-linked`);
    }
  });

  it('leaves a folder for the next pass when it cannot tell whether a container works in it', async () => {
    const host = hostProcesses(2);
    const processes = createContainerFolderProcesses({ binary: 'podman', host, run: runtimeListing(() => ({ status: 125, stderr: 'cannot connect' })) });

    await expect(processes.stopIn(folder)).rejects.toThrow(`Cannot tell whether a container works in ${folder}, so it is left for the next pass: cannot connect`);
    expect(host.asked).toEqual([]);
  });

  it('stops the processes on the host in a folder only an exited container had', async () => {
    const processes = createContainerFolderProcesses({ binary: 'podman', host: hostProcesses(1), run: runtimeListing(() => ({ stdout: 'trierarch-shp_scout exited\n' })) });

    await expect(processes.stopIn(folder)).resolves.toBe(1);
  });
});
