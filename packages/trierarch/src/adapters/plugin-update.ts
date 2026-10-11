import { cp, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PluginHarness } from './plugin.js';
import { runCommand } from './run-command.js';

/**
 * The aeolus plugin updated through each harness's own command (#581).
 * Codex's plugin upgrade installs the new version and deletes every other
 * version folder, so a Codex session still running on the old version would
 * lose its plugin scripts: the version folders there before are kept aside and
 * put back beside the new one, also when the upgrade fails. Claude Code keeps
 * old versions beside the new one itself.
 */
export interface PluginUpdate {
  update(harness: PluginHarness): Promise<void>;
}

const MARKETPLACE = 'aeolus-fleet';
const PLUGIN = 'aeolus@aeolus-fleet';

async function run(command: string, args: readonly string[]): Promise<void> {
  const result = await runCommand(command, { args });
  if (result.status !== 0) {
    throw new Error(`${[command, ...args].join(' ')} failed: ${`${result.stdout}${result.stderr}`.trim()}`);
  }
}

/** The folders under `cache`, none where it does not exist. */
async function versionFolders(cache: string): Promise<string[]> {
  const names = await readdir(cache).catch(() => []);
  const folders: string[] = [];
  for (const name of names) {
    if ((await stat(join(cache, name))).isDirectory()) {
      folders.push(name);
    }
  }
  return folders;
}

/** Runs `upgrade` with every version folder in `cache` kept aside, and puts back each one it deleted. */
async function keepingVersions(cache: string, upgrade: () => Promise<void>): Promise<void> {
  const versions = await versionFolders(cache);
  const aside = await mkdtemp(join(tmpdir(), 'aeolus-plugin-versions-'));
  try {
    for (const version of versions) {
      await cp(join(cache, version), join(aside, version), { recursive: true, preserveTimestamps: true });
    }
    try {
      await upgrade();
    } finally {
      const left = new Set(await versionFolders(cache));
      for (const version of versions.filter((name) => !left.has(name))) {
        await cp(join(aside, version), join(cache, version), { recursive: true, preserveTimestamps: true });
      }
    }
  } finally {
    await rm(aside, { recursive: true, force: true });
  }
}

export function createPluginUpdate(at: {
  homeDirectory: string;
  env: Readonly<Record<string, string | undefined>>;
  /** The programs to run; `codex` and `claude` unless a test runs others. */
  commands?: Partial<Record<PluginHarness, string>>;
}): PluginUpdate {
  const codex = at.commands?.codex ?? 'codex';
  const claude = at.commands?.['claude-code'] ?? 'claude';
  const codexCache = join(at.env.CODEX_HOME ?? join(at.homeDirectory, '.codex'), 'plugins', 'cache', MARKETPLACE, 'aeolus');

  return {
    update: async (harness) => {
      if (harness === 'codex') {
        await keepingVersions(codexCache, () => run(codex, ['plugin', 'marketplace', 'upgrade', MARKETPLACE]));
        return;
      }
      await run(claude, ['plugin', 'marketplace', 'update', MARKETPLACE]);
      await run(claude, ['plugin', 'update', PLUGIN]);
    },
  };
}
