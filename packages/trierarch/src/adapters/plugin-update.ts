import { cp, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { z } from 'zod';

import { codexKeepsPluginData } from './codex-plugin-data.js';
import { byVersion, type PluginHarness } from './plugin.js';
import { runCommand } from './run-command.js';
import { runningProcesses, type RunningProcess } from './running-processes.js';

/**
 * The aeolus-fleet plugin updated through each harness's own command (#581), from
 * the release tag it is given, or main without one (#652): each harness's
 * aeolus-fleet marketplace is pointed at it first. Neither harness adds a
 * second source for a marketplace. Codex's is removed and added again, which
 * keeps the plugin and its cache, once a throwaway Codex home proves this
 * Codex keeps the plugin's data, its log and the crew identities not yet
 * moved to ~/.aeolus/crews, when it is removed (#660); the upgrade changes
 * nothing otherwise. Claude Code's is never removed, since that uninstalls the
 * plugin and deletes its data, with its log and those identities: the
 * marketplace its settings declare is dropped from them, and adding it again
 * declares the new source.
 * Codex's plugin upgrade installs the new version and deletes every other
 * version folder, so a Codex session still running on the old version would
 * lose its plugin scripts: the version folders there before are kept aside and
 * put back beside the new one, also when the upgrade fails. After an upgrade
 * that succeeded, a version folder no running session can use is removed
 * (#653): a session uses the newest version there was when it started, so a
 * version is left behind once its next version came before every running
 * Codex process, and the trierarch, started. A version counts from when the
 * upgrade installed it. Claude Code keeps old versions beside the new one
 * itself.
 */
export interface PluginUpdate {
  /** `tag`: the release tag to install the plugin from; none installs it from main. */
  update(harness: PluginHarness, tag: string | undefined): Promise<void>;
}

const MARKETPLACE = 'aeolus-fleet';
const REPOSITORY = 'ThomasHendrickx/aeolus-fleet-trierarch';
const PLUGIN = 'aeolus-fleet@aeolus-fleet';

async function run(command: string, args: readonly string[]): Promise<void> {
  const result = await runCommand(command, { args });
  if (result.status !== 0) {
    throw new Error(`${[command, ...args].join(' ')} failed: ${`${result.stdout}${result.stderr}`.trim()}`);
  }
}

const settingsSchema = z.record(z.string(), z.unknown());
const marketplacesSchema = z.record(z.string(), z.unknown());

/** Drops the aeolus-fleet marketplace from the `extraKnownMarketplaces` of Claude Code's settings, leaving everything else as it is. */
async function dropDeclaredMarketplace(path: string): Promise<void> {
  const text = await readFile(path, 'utf8').catch(() => undefined);
  if (text === undefined) {
    return;
  }
  const settings = settingsSchema.parse(JSON.parse(text));
  const declared = marketplacesSchema.safeParse(settings.extraKnownMarketplaces).data;
  if (declared?.[MARKETPLACE] === undefined) {
    return;
  }
  const others = Object.fromEntries(Object.entries(declared).filter(([name]) => name !== MARKETPLACE));
  const temporary = `${path}.aeolus-trierarch.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...settings, extraKnownMarketplaces: others }, null, 2)}\n`, { mode: (await stat(path)).mode & 0o777 });
  await rename(temporary, path);
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

/** ps says elapsed time in whole seconds, and a session takes a moment to read its plugin: a start this close after a version came may still have found the one before. */
const START_MARGIN_MS = 60 * 1000;

const VERSION = /^\d+\.\d+\.\d+$/;

/** Marks each version folder the upgrade installed with the time it did, whatever times Codex gave its files. */
async function markInstalled(cache: string, at: { before: readonly string[]; now: Date }): Promise<void> {
  for (const version of await versionFolders(cache)) {
    if (!at.before.includes(version)) {
      await utimes(join(cache, version), at.now, at.now);
    }
  }
}

/** Removes each version folder whose next version came before the earliest start, every older one when nothing runs. */
async function removeUnused(cache: string, earliestStart: Date | undefined): Promise<void> {
  const versions = (await versionFolders(cache)).filter((name) => VERSION.test(name)).sort(byVersion);
  for (const [index, version] of versions.entries()) {
    const next = versions[index + 1];
    if (next === undefined) {
      continue;
    }
    const nextCame = (await stat(join(cache, next))).mtime.getTime();
    if (earliestStart === undefined || earliestStart.getTime() >= nextCame + START_MARGIN_MS) {
      await rm(join(cache, version), { recursive: true, force: true });
    }
  }
}

/** The earliest start of a process that may use a Codex plugin version: a Codex one, or the trierarch. */
function earliestStartOf(processes: readonly RunningProcess[], trierarchPid: number | undefined): Date | undefined {
  const users = processes.filter((process) => basename(process.program) === 'codex' || process.pid === trierarchPid);
  return users.map((process) => process.startedAt).reduce<Date | undefined>((earliest, startedAt) => (earliest === undefined || startedAt < earliest ? startedAt : earliest), undefined);
}

/** Runs `upgrade` with every version folder in `cache` kept aside, and puts back each one it deleted; then removes the unused ones. */
async function keepingVersions(cache: string, at: { upgrade: () => Promise<void>; afterUpgrade: (before: readonly string[]) => Promise<void> }): Promise<void> {
  const versions = await versionFolders(cache);
  const times = new Map(await Promise.all(versions.map(async (version) => [version, await stat(join(cache, version))] as const)));
  const aside = await mkdtemp(join(tmpdir(), 'aeolus-plugin-versions-'));
  try {
    for (const version of versions) {
      await cp(join(cache, version), join(aside, version), { recursive: true, preserveTimestamps: true });
    }
    try {
      await at.upgrade();
    } finally {
      const left = new Set(await versionFolders(cache));
      for (const version of versions.filter((name) => !left.has(name))) {
        await cp(join(aside, version), join(cache, version), { recursive: true, preserveTimestamps: true });
        // cp keeps the times of files, not of folders: the folder's time says when its version came.
        const time = times.get(version);
        if (time !== undefined) {
          await utimes(join(cache, version), time.atime, time.mtime);
        }
      }
    }
    await at.afterUpgrade(versions);
  } finally {
    await rm(aside, { recursive: true, force: true });
  }
}

export function createPluginUpdate(at: {
  homeDirectory: string;
  env: Readonly<Record<string, string | undefined>>;
  /** The programs to run; `codex` and `claude` unless a test runs others. */
  commands?: Partial<Record<PluginHarness, string>>;
  /** The clock; a test passes its own. */
  now?: () => Date;
  /** The processes running on this machine now; ps unless a test says them. */
  processes?: (now: Date) => Promise<readonly RunningProcess[]>;
  /** The running trierarch's pid, none when none runs: it took its plugin scripts from the newest version when it started. */
  trierarchPid: () => Promise<number | undefined>;
}): PluginUpdate {
  const now = at.now ?? (() => new Date());
  const processes = at.processes ?? runningProcesses;
  const codex = at.commands?.codex ?? 'codex';
  const claude = at.commands?.['claude-code'] ?? 'claude';
  const claudeSettings = join(at.env.CLAUDE_CONFIG_DIR ?? join(at.homeDirectory, '.claude'), 'settings.json');
  const codexCache = join(at.env.CODEX_HOME ?? join(at.homeDirectory, '.codex'), 'plugins', 'cache', MARKETPLACE, 'aeolus-fleet');

  return {
    update: async (harness, tag) => {
      if (harness === 'codex') {
        if (!(await codexKeepsPluginData(codex))) {
          throw new Error(`Codex would delete the aeolus-fleet plugin's data on this machine, its log and the crew identities not yet moved to ~/.aeolus/crews, when its ${MARKETPLACE} marketplace is removed: the upgrade leaves the marketplace as it is`);
        }
        await keepingVersions(codexCache, {
          upgrade: async () => {
            // There may be no marketplace to remove: adding it says what is wrong.
            await runCommand(codex, { args: ['plugin', 'marketplace', 'remove', MARKETPLACE] });
            await run(codex, ['plugin', 'marketplace', 'add', REPOSITORY, ...(tag === undefined ? [] : ['--ref', tag])]);
            await run(codex, ['plugin', 'marketplace', 'upgrade', MARKETPLACE]);
            // The marketplace upgrade updates an installed plugin only: with its cache folder emptied there is none to update (#1212).
            if ((await versionFolders(codexCache)).filter((name) => VERSION.test(name)).length === 0) {
              await run(codex, ['plugin', 'add', PLUGIN]);
            }
          },
          afterUpgrade: async (before) => {
            const upgradedAt = now();
            await markInstalled(codexCache, { before, now: upgradedAt });
            await removeUnused(codexCache, earliestStartOf(await processes(upgradedAt), await at.trierarchPid()));
          },
        });
        return;
      }
      await dropDeclaredMarketplace(claudeSettings);
      await run(claude, ['plugin', 'marketplace', 'add', tag === undefined ? REPOSITORY : `${REPOSITORY}#${tag}`]);
      await run(claude, ['plugin', 'marketplace', 'update', MARKETPLACE]);
      await run(claude, ['plugin', 'update', PLUGIN]);
    },
  };
}
