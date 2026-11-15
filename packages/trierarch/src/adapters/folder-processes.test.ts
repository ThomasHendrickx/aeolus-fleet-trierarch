import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { aTrierarch, crewSettings, SHIPS_ROOT } from '../../test/support/in-memory.js';
import { createFolderProcesses, foldersFromLsof, isInside, readProcessFolders } from './folder-processes.js';

describe('the folders processes work in, as lsof says them', () => {
  it('pairs each process with the folder on the line after it', () => {
    expect(foldersFromLsof('p12\nfcwd\nn/work/a\np34\nfcwd\nn/work/b\n')).toEqual([
      { pid: 12, folder: '/work/a' },
      { pid: 34, folder: '/work/b' },
    ]);
  });
});

describe('a process inside a folder', () => {
  it('works in the folder itself or below it', () => {
    expect(isInside('/root/repo/lookout', '/root/repo/lookout')).toBe(true);
    expect(isInside('/root/repo/lookout/web', '/root/repo/lookout')).toBe(true);
  });

  it('is not in a folder that only shares the start of its name', () => {
    expect(isInside('/root/repo/lookout-2', '/root/repo/lookout')).toBe(false);
  });

  it('is in the folder when it was removed from under the process', () => {
    expect(isInside('/root/repo/lookout (deleted)', '/root/repo/lookout')).toBe(true);
  });
});

describe('stopping the processes in a folder (#1041)', () => {
  const children: ChildProcess[] = [];
  const folders: string[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) {
      child.kill('SIGKILL');
    }
    for (const folder of folders.splice(0)) {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  function aFolder(): string {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'folder-processes-')));
    folders.push(folder);
    return folder;
  }

  function runIn(cwd: string, script = 'setInterval(() => undefined, 1000)'): ChildProcess {
    const child = spawn(process.execPath, ['-e', script], { cwd, stdio: 'ignore' });
    children.push(child);
    return child;
  }

  const exited = (child: ChildProcess) =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once('exit', () => {
        resolve();
      });
    });

  it('stops a process working in the folder or below it, and none beside it', async () => {
    const folder = aFolder();
    const below = join(folder, 'web');
    mkdirSync(below);
    const inside = runIn(folder);
    const deeper = runIn(below);
    const beside = runIn(aFolder());
    await new Promise((resolve) => setTimeout(resolve, 300));

    const stopped = await createFolderProcesses().stopIn(folder);

    await Promise.all([exited(inside), exited(deeper)]);
    expect(stopped).toBe(2);
    expect(beside.exitCode).toBeNull();
    expect(beside.signalCode).toBeNull();
  });

  it('kills a process that ignores the request to end once the grace period is spent', async () => {
    const folder = aFolder();
    const stubborn = runIn(folder, "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000)");
    await new Promise((resolve) => setTimeout(resolve, 300));

    await createFolderProcesses({ graceMs: 300 }).stopIn(folder);

    await exited(stubborn);
    expect(stubborn.signalCode).toBe('SIGKILL');
  });

  it('stops nothing in a folder nothing works in', async () => {
    expect(await createFolderProcesses().stopIn(aFolder())).toBe(0);
  });

  it('on a release, stops a process in the home/ folder beside the repositories of the ship folder, and none outside the ship folder (#436)', async () => {
    const onDisk = aFolder();
    mkdirSync(join(onDisk, 'home'));
    const inHome = runIn(join(onDisk, 'home'));
    const outside = runIn(aFolder());
    await new Promise((resolve) => setTimeout(resolve, 300));
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    trierarch.fleet.request(shipId, crewSettings());
    await trierarch.pass();
    await trierarch.pass();
    const shipFolder = `${SHIPS_ROOT}/${shipId}`;
    // Only the processes this test started are stopped, the in-memory ship folder standing for the folder on disk.
    const ours = new Set([inHome.pid, outside.pid]);
    const stopper = createFolderProcesses({ processFolders: () => readProcessFolders().filter((each) => ours.has(each.pid)), graceMs: 300 });
    trierarch.folderProcesses.stopIn = (folder) => stopper.stopIn(folder.replace(shipFolder, onDisk));
    trierarch.fleet.removeRequest(shipId);

    await trierarch.pass();

    expect(trierarch.workspace.removedShipFolders).toContain(shipFolder);
    await exited(inHome);
    expect(inHome.signalCode).toBe('SIGTERM');
    expect(outside.exitCode).toBeNull();
    expect(outside.signalCode).toBeNull();
  });
});
