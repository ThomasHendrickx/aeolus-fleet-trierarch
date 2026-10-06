import { mkdir, stat, writeFile } from 'node:fs/promises';

import { idSchema } from '@aeolus-fleet/common';

import { configurationJsonSchema, initialConfiguration, writeCrewFile } from '../adapters/files.js';
import type { TrierarchPaths } from '../adapters/paths.js';
import type { RestFleet } from '../adapters/rest-fleet.js';

/**
 * `aeolus-trierarch init <fleetUrl> <shipId> <secret>`: registers the
 * trierarch's own ship (commissioned with fleet:crew) with its secret and
 * keeps the crew token, readable by its user only. Writes a configuration with
 * no repository, folder or flag when there is none yet, with its JSON Schema
 * beside it. The secret is never written.
 */
export async function initTrierarch(input: {
  paths: TrierarchPaths;
  crew: { fleetUrl: string; shipId: string; secret: string };
  fleetAt: (fleetUrl: string) => Pick<RestFleet, 'registerSelf'>;
}): Promise<string[]> {
  const { paths, crew, fleetAt } = input;
  const shipId = idSchema('ship').parse(crew.shipId);
  const { crewToken } = await fleetAt(crew.fleetUrl).registerSelf({ shipId, secret: crew.secret });
  await writeCrewFile(paths.crewToken, { fleetUrl: crew.fleetUrl.replace(/\/$/, ''), crewToken });
  const said = [`Crew token kept in ${paths.crewToken}.`];
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await writeFile(paths.configSchema, `${JSON.stringify(configurationJsonSchema(), null, 2)}\n`);
  if ((await stat(paths.config).catch(() => undefined)) === undefined) {
    await writeFile(paths.config, `${JSON.stringify(initialConfiguration(), null, 2)}\n`);
    said.push(`Configuration written to ${paths.config}: add the repositories and folders it may crew ships in, then run aeolus-trierarch config check.`);
  } else {
    said.push(`Configuration kept as it is at ${paths.config}.`);
  }
  return said;
}
