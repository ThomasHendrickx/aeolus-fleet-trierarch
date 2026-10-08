import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { trierarchConfigurationSchema, type TrierarchConfiguration } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClaudeCodeSetup } from '../adapters/claude-code-setup.js';
import { initialConfiguration } from '../adapters/files.js';
import { trierarchPaths, type TrierarchPaths } from '../adapters/paths.js';
import type { ServiceStatus } from '../adapters/service.js';
import { addPlace, type AddPlace } from './add.js';

let home: string;
let paths: TrierarchPaths;
let pagasae: string;
let codexTrusted: string[];
let isCodexFailing: boolean;
let restarts: number;
let isServiceInstalled: boolean;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'trierarch-add-'));
  paths = trierarchPaths({ homeDirectory: home });
  pagasae = join(home, 'Projects', 'pagasae');
  mkdirSync(join(pagasae, '.git'), { recursive: true });
  codexTrusted = [];
  isCodexFailing = false;
  restarts = 0;
  isServiceInstalled = true;
  writeConfiguration(initialConfiguration());
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeConfiguration(configuration: TrierarchConfiguration): void {
  mkdirSync(dirname(paths.config), { recursive: true });
  writeFileSync(paths.config, JSON.stringify(configuration));
}

function configuration(): TrierarchConfiguration {
  return trierarchConfigurationSchema.parse(JSON.parse(readFileSync(paths.config, 'utf8')));
}

function add(place: Pick<AddPlace, 'kind' | 'name' | 'path'>) {
  return addPlace({
    ...place,
    paths,
    homeDirectory: home,
    claudeCode: createClaudeCodeSetup({ homeDirectory: home }),
    codex: {
      trust: (folders) => {
        if (isCodexFailing) {
          return Promise.reject(new Error('codex app-server did not answer config/batchWrite'));
        }
        codexTrusted.push(...folders);
        return Promise.resolve();
      },
    },
    service: {
      status: (): Promise<ServiceStatus> => Promise.resolve({ file: '/LaunchAgents/dev.aeolus-fleet.trierarch.plist', isInstalled: isServiceInstalled, isRunning: isServiceInstalled }),
      restart: () => {
        restarts += 1;
        return Promise.resolve();
      },
    },
  });
}

const isClaudeCodeTrusting = (path: string) => createClaudeCodeSetup({ homeDirectory: home }).isTrusted(path);

describe('aeolus-trierarch add (#381)', () => {
  it('adds a repository by name and path, trusts it for Claude Code, and restarts the service so the trierarch reads it, its sessions running on', async () => {
    const report = await add({ kind: 'repository', name: 'pagasae', path: pagasae });

    expect(configuration().repositories).toEqual({ pagasae: { path: pagasae } });
    await expect(isClaudeCodeTrusting(pagasae)).resolves.toBe(true);
    expect(restarts).toBe(1);
    expect(report.said).toEqual([
      `Added the repository pagasae (${pagasae}) to ${paths.config}.`,
      'Claude Code trusts it.',
      'The trierarch restarted to offer it; its sessions kept running.',
    ]);
  });

  it('adds a folder, keeping everything else the configuration holds', async () => {
    const notes = join(home, 'notes');
    mkdirSync(notes);
    writeConfiguration({ ...initialConfiguration(), caps: { ships: 6, running: 3 }, repositories: { pagasae: { path: pagasae } } });

    await add({ kind: 'folder', name: 'notes', path: notes });

    expect(configuration()).toMatchObject({ caps: { ships: 6, running: 3 }, repositories: { pagasae: { path: pagasae } }, folders: { notes: { path: notes } } });
    await expect(isClaudeCodeTrusting(notes)).resolves.toBe(true);
  });

  it('trusts it for Codex too when the configuration offers Codex', async () => {
    writeConfiguration({ ...initialConfiguration(), harnesses: { 'claude-code': { flags: [], options: {} }, codex: { flags: [], options: {} } } });

    const report = await add({ kind: 'repository', name: 'pagasae', path: pagasae });

    expect(codexTrusted).toEqual([pagasae]);
    expect(report.said).toContain('Codex trusts it.');
  });

  it('says so when Codex cannot trust it, as no Codex session is crewed there until it does', async () => {
    writeConfiguration({ ...initialConfiguration(), harnesses: { 'claude-code': { flags: [], options: {} }, codex: { flags: [], options: {} } } });
    isCodexFailing = true;

    const report = await add({ kind: 'repository', name: 'pagasae', path: pagasae });

    expect(configuration().repositories).toEqual({ pagasae: { path: pagasae } });
    expect(report.said).toContain(
      'Codex does not trust it: codex app-server did not answer config/batchWrite. The trierarch offers it once every harness trusts it: run this again when Codex runs.',
    );
  });

  it('takes a path from the home directory with ~', async () => {
    await add({ kind: 'repository', name: 'pagasae', path: '~/Projects/pagasae' });

    expect(configuration().repositories).toEqual({ pagasae: { path: pagasae } });
  });

  it('trusts a place it holds already again, under the same name and path', async () => {
    writeConfiguration({ ...initialConfiguration(), repositories: { pagasae: { path: pagasae } } });

    await add({ kind: 'repository', name: 'pagasae', path: pagasae });

    await expect(isClaudeCodeTrusting(pagasae)).resolves.toBe(true);
    expect(configuration().repositories).toEqual({ pagasae: { path: pagasae } });
  });

  it('only writes and trusts while the service is not installed, and says how to start it', async () => {
    isServiceInstalled = false;

    const report = await add({ kind: 'repository', name: 'pagasae', path: pagasae });

    expect(restarts).toBe(0);
    expect(report.said.at(-1)).toBe('The service is not installed: run aeolus-trierarch install to run it.');
  });

  it.each([
    { label: 'a repository that is no git checkout', place: () => ({ kind: 'repository' as const, name: 'notes', path: join(home, 'notes') }), why: () => `${join(home, 'notes')} is no git checkout.` },
    { label: 'a folder that does not exist', place: () => ({ kind: 'folder' as const, name: 'notes', path: join(home, 'notes') }), why: () => `${join(home, 'notes')} is no folder.` },
    { label: 'a name that is no name', place: () => ({ kind: 'repository' as const, name: 'Pagasae', path: pagasae }), why: () => 'Pagasae is no name: lowercase letters, digits and hyphens.' },
  ])('refuses $label, writing and trusting nothing', async ({ place, why }) => {
    await expect(add(place())).rejects.toThrow(why());
    expect(configuration().repositories).toEqual({});
    expect(restarts).toBe(0);
  });

  it('refuses a name that names another place already, writing and trusting nothing', async () => {
    const elsewhere = join(home, 'elsewhere');
    writeConfiguration({ ...initialConfiguration(), repositories: { pagasae: { path: elsewhere } } });

    await expect(add({ kind: 'repository', name: 'pagasae', path: pagasae })).rejects.toThrow(`pagasae names ${elsewhere} already: pick another name`);
    await expect(isClaudeCodeTrusting(pagasae)).resolves.toBe(false);
  });
});
