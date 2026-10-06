import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { idSchema, trierarchConfigurationSchema, type ShipId, type TrierarchConfiguration } from '@aeolus-fleet/common';
import { z } from 'zod';

/**
 * The trierarch's own files: its configuration, written by the operator, and
 * its crew file, written by `init`: the fleet's URL and the trierarch's own
 * crew token, readable by its user only.
 */

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

/** The fleet, the trierarch's own ship and its crew token. A crew file written before the ship id was kept lacks it. */
export interface CrewFile {
  readonly fleetUrl: string;
  readonly shipId?: ShipId;
  readonly crewToken: string;
}

export async function writeCrewFile(path: string, crew: CrewFile & { shipId: ShipId }): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `fleetUrl=${crew.fleetUrl}\nshipId=${crew.shipId}\ncrewToken=${crew.crewToken}\n`, { mode: 0o600 });
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
  return { fleetUrl, ...(shipId.success && { shipId: shipId.data }), crewToken };
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
