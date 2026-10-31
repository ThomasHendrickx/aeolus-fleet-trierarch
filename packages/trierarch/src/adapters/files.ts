import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { idSchema, trierarchConfigurationSchema as commonConfigurationSchema, trierarchNameSchema, type ShipId } from '@aeolus-fleet/common';
import { z } from 'zod';

import { LOGINS } from '../core/login.js';
import { withoutRemoteControl } from '../core/remote-control.js';

/**
 * The trierarch's own files: its configuration, written by the operator, and
 * its crew file, written by `init`: the fleet's URL and the trierarch's own
 * crew token, readable by its user only.
 */

/**
 * The configuration as common states it, with each repository's read-only
 * checkouts (#1182): the configured repositories a session in that repository
 * gets beside its working folder, at the latest main. They are named, never a
 * path, so only a repository the machine already trusts is checked out. And
 * whether a repository is read-only (aeolus-fleet#1449): its sessions' working
 * folder is a read-only clone on main in place of a worktree. Kept
 * here rather than in common: only the trierarch reads its configuration, and
 * a crew request never names them. With them, the price table the cost of a
 * ship's tokens is estimated by (#353): per model, in US dollars per million
 * tokens of each kind, in place of its list price or for a model with none.
 * And which login each session runs on (api keys K5): a default per harness
 * and a login per ship name, never a key or a path.
 */
const priceSchema = z.number().nonnegative();
const loginSchema = z.enum(LOGINS);

export const trierarchConfigurationSchema = commonConfigurationSchema
  .extend({
    repositories: z.record(trierarchNameSchema, z.strictObject({ path: z.string().min(1), checkouts: z.array(trierarchNameSchema).optional(), readOnly: z.boolean().optional() })),
    prices: z.record(z.string().min(1), z.strictObject({ input: priceSchema, output: priceSchema, cacheRead: priceSchema, cacheWrite: priceSchema })).optional(),
    logins: z.strictObject({ default: z.strictObject({ 'claude-code': loginSchema.optional(), codex: loginSchema.optional() }).optional(), ships: z.record(z.string().min(1), loginSchema).optional() }).optional(),
  })
  .superRefine((configuration, context) => {
    for (const [repository, { checkouts = [] }] of Object.entries(configuration.repositories)) {
      checkouts.forEach((checkout, index) => {
        const path = ['repositories', repository, 'checkouts', index];
        if (checkout === repository) {
          context.addIssue({ code: 'custom', path, message: `${checkout} is the repository itself, the session's working folder` });
        } else if (!(checkout in configuration.repositories)) {
          context.addIssue({ code: 'custom', path, message: `${checkout} is no repository of this configuration` });
        } else if (checkouts.indexOf(checkout) !== index) {
          context.addIssue({ code: 'custom', path, message: `${checkout} is named twice` });
        }
      });
    }
  });
export type TrierarchConfiguration = z.infer<typeof trierarchConfigurationSchema>;

/** A file the trierarch cannot use, with why, for the operator to read. */
export class TrierarchFileError extends Error {}

/** The configuration a fresh `init` writes: no repository or folder yet, Claude Code with no flag. The trierarch adds no flag by itself. */
export function initialConfiguration(): TrierarchConfiguration & { $schema: string } {
  return {
    $schema: './config.schema.json',
    caps: { ships: 4, running: 2 },
    repositories: {},
    folders: {},
    harnesses: { 'claude-code': { flags: [], options: {} } },
  };
}

/** The configuration's JSON Schema, written beside it so an editor checks it. */
export function configurationJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(trierarchConfigurationSchema, { io: 'input' });
}

export async function loadConfiguration(path: string): Promise<TrierarchConfiguration> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new TrierarchFileError(`No configuration at ${path}: run aeolus-trierarch init first`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new TrierarchFileError(`The configuration at ${path} is no JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = trierarchConfigurationSchema.safeParse(json);
  if (!parsed.success) {
    throw new TrierarchFileError(`The configuration at ${path} does not fit:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * Takes Remote Control out of the configuration at the path, keeping all else
 * it holds (headless H20): answers the harnesses whose flags carried it; none
 * without a configuration that fits.
 */
export async function removeRemoteControl(path: string): Promise<readonly string[]> {
  const configuration = await loadConfiguration(path).catch(() => undefined);
  const without = configuration === undefined ? undefined : withoutRemoteControl(configuration);
  if (without === undefined || without.harnesses.length === 0) {
    return [];
  }
  const raw = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(path, 'utf8')));
  await writeFile(path, `${JSON.stringify({ ...raw, harnesses: without.configuration.harnesses }, null, 2)}\n`);
  return without.harnesses;
}

/** The fleet, the trierarch's own ship and its crew token. A crew file written before the ship id was kept lacks it. */
export interface CrewFile {
  readonly fleetUrl: string;
  readonly shipId?: ShipId;
  /** The trierarch plugin's ship, the one ship the trusted repositories are taken from (aeolus-fleet#384); none on a machine set up before. */
  readonly pluginShipId?: ShipId;
  readonly crewToken: string;
}

export async function writeCrewFile(path: string, crew: CrewFile & { shipId: ShipId }): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const plugin = crew.pluginShipId === undefined ? '' : `pluginShipId=${crew.pluginShipId}\n`;
  await writeFile(path, `fleetUrl=${crew.fleetUrl}\nshipId=${crew.shipId}\n${plugin}crewToken=${crew.crewToken}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function readCrewFile(path: string): Promise<CrewFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new TrierarchFileError(`No crew token at ${path}: run aeolus-trierarch init first`);
  }
  const field = (name: string): string | undefined => new RegExp(`^${name}=(.+)$`, 'm').exec(text)?.[1];
  const fleetUrl = field('fleetUrl');
  const crewToken = field('crewToken');
  if (fleetUrl === undefined || crewToken === undefined) {
    throw new TrierarchFileError(`The crew file at ${path} lacks its fleetUrl or crewToken line: run aeolus-trierarch init again`);
  }
  const shipId = idSchema('ship').safeParse(field('shipId'));
  const pluginShipId = idSchema('ship').safeParse(field('pluginShipId'));
  return { fleetUrl, ...(shipId.success && { shipId: shipId.data }), ...(pluginShipId.success && { pluginShipId: pluginShipId.data }), crewToken };
}

/** What the running trierarch says of itself: its pid and its version, as it started. */
export interface RunningFile {
  readonly pid: number;
  readonly version: string;
}

const runningFileSchema = z.object({ pid: z.int().positive(), version: z.string() });

/** Written by `run` as it starts: an upgrade replaces the installed files, so only the process itself knows the version it runs. */
export async function writeRunningFile(path: string, running: RunningFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(running)}\n`);
}

/** None when no trierarch wrote it (one before 0.18.0 did not) or it does not fit. */
export async function readRunningFile(path: string): Promise<RunningFile | undefined> {
  try {
    const parsed = runningFileSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
