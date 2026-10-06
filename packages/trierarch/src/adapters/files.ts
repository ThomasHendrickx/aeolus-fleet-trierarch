import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { trierarchConfigurationSchema, type TrierarchConfiguration } from '@aeolus-fleet/common';
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

/** The fleet and the trierarch's own crew token. */
export interface CrewFile {
  readonly fleetUrl: string;
  readonly crewToken: string;
}

export async function writeCrewFile(path: string, crew: CrewFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `fleetUrl=${crew.fleetUrl}\ncrewToken=${crew.crewToken}\n`, { mode: 0o600 });
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
  return { fleetUrl, crewToken };
}
