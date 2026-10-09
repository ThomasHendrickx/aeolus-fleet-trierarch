import { readFile, writeFile } from 'node:fs/promises';

import { z } from 'zod';

import type { ClaudeCodeSetup } from '../adapters/claude-code-setup.js';
import type { CodexSetup } from '../adapters/codex-setup.js';
import { loadConfiguration, TrierarchFileError } from '../adapters/files.js';
import type { TrierarchPaths } from '../adapters/paths.js';
import type { Service } from '../adapters/service.js';
import { absolutePath, nameRefusal, placeRefusal, type PlaceKind } from './places.js';

/**
 * `aeolus-trierarch add repository|folder <name> <path>` (#381): adds a place
 * the trierarch may crew ships in, and trusts it, in one step. Adding a place
 * is what trusts it: it is checked as init checks it, written to the
 * configuration, and trusted for every configured harness that asks. Then the
 * service restarts so the trierarch reads it; its sessions run on their own
 * tmux server and keep running. A place it holds under the same name and path
 * is trusted again.
 */

export interface AddPlace {
  readonly kind: PlaceKind;
  readonly name: string;
  /** As the operator wrote it: `~` is the home directory. */
  readonly path: string;
  readonly paths: TrierarchPaths;
  readonly homeDirectory: string;
  readonly claudeCode: Pick<ClaudeCodeSetup, 'trust'>;
  readonly codex: Pick<CodexSetup, 'trust'>;
  readonly service: Pick<Service, 'status' | 'restart'>;
}

export interface AddReport {
  readonly kind: PlaceKind;
  readonly name: string;
  readonly path: string;
  /** The harnesses that trust it now. */
  readonly trustedBy: readonly string[];
  readonly service: 'restarted' | 'notInstalled';
  readonly said: readonly string[];
}

const CODEX = 'codex';
const CLAUDE_CODE = 'claude-code';

const placesSchema = z.record(z.string(), z.object({ path: z.string() }).loose());
const rawSchema = z.object({ repositories: placesSchema, folders: placesSchema }).loose();

export async function addPlace(at: AddPlace): Promise<AddReport> {
  const { kind, name, paths, claudeCode, codex, service } = at;
  const path = absolutePath(at.path, at.homeDirectory);
  const why = nameRefusal(name) ?? (await placeRefusal(kind, path));
  if (why !== undefined) {
    throw new TrierarchFileError(why);
  }
  // Checked as the trierarch reads it; written back as it is, every key kept.
  const configuration = await loadConfiguration(paths.config);
  const raw = rawSchema.parse(JSON.parse(await readFile(paths.config, 'utf8')));
  const key = kind === 'repository' ? 'repositories' : 'folders';
  const held = configuration.repositories[name] ?? configuration.folders[name];
  if (held !== undefined && (held.path !== path || !(name in configuration[key]))) {
    throw new TrierarchFileError(`${name} names ${held.path} already: pick another name`);
  }
  await writeFile(paths.config, `${JSON.stringify({ ...raw, [key]: { ...raw[key], [name]: { path } } }, null, 2)}\n`);
  const said = [`Added the ${kind} ${name} (${path}) to ${paths.config}.`];

  const trustedBy: string[] = [];
  if (configuration.harnesses[CLAUDE_CODE] !== undefined) {
    await claudeCode.trust(path);
    trustedBy.push(CLAUDE_CODE);
    said.push('Claude Code trusts it.');
  }
  if (configuration.harnesses[CODEX] !== undefined) {
    try {
      await codex.trust([path]);
      trustedBy.push(CODEX);
      said.push('Codex trusts it.');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      said.push(`Codex does not trust it: ${reason}. The trierarch offers it once every harness trusts it: run this again when Codex runs.`);
    }
  }

  if (!(await service.status()).isInstalled) {
    said.push('The service is not installed: run aeolus-trierarch install to run it.');
    return { kind, name, path, trustedBy, service: 'notInstalled', said };
  }
  await service.restart();
  said.push('The trierarch restarted to offer it; its sessions kept running.');
  return { kind, name, path, trustedBy, service: 'restarted', said };
}
