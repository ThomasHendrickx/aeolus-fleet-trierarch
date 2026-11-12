import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TrierarchConfiguration } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIGURATION, InMemoryContainerHost } from '../../test/support/in-memory.js';
import { TrierarchFileError } from '../adapters/files.js';
import { trierarchPaths, type TrierarchPaths } from '../adapters/paths.js';
import { checkShipsPlace, configCheck } from './config-check.js';
import { aShortHome } from '../../test/support/short-home.js';

const CONTAINER = { kind: 'container', binary: 'podman', memory: '4g', cpus: 2 } as const;
/** What config check reads of Claude Code's own files: nothing makes plan its default mode. */
const FILES = { claudeCode: { defaultPermissionMode: () => Promise.resolve({ kind: 'decided' as const, mode: undefined }) } };

let home: string;
let paths: TrierarchPaths;
let host: InMemoryContainerHost;

beforeEach(() => {
  home = aShortHome('trierarch-check');
  paths = trierarchPaths({ homeDirectory: home, config: join(home, 'config.json') });
  host = new InMemoryContainerHost();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A configuration as an operator writes it now: Claude Code with no model option (#382) and no Remote Control. */
const SESSIONS: TrierarchConfiguration = { ...CONFIGURATION, harnesses: { 'claude-code': { flags: [], options: {} } } };

function configured(configuration: TrierarchConfiguration): void {
  writeFileSync(paths.config, JSON.stringify(configuration));
}

describe('config check, with the session runtime (decision 0039)', () => {
  it('says the sessions run on the host when the configuration names no runtime', async () => {
    configured(SESSIONS);

    const report = await configCheck(paths, { files: FILES, host });

    expect({ runtime: report.runtime, says: report.text.includes('Sessions run on the host.') }).toEqual({ runtime: { kind: 'host' }, says: true });
  });

  it('says the sessions run in containers, with their caps and where the model token is read, when the container runtime fits', async () => {
    configured({ ...SESSIONS, runtime: CONTAINER });

    const report = await configCheck(paths, { files: FILES, host });

    expect(report.text).toContain(`Sessions run in containers of podman, each capped at 4g of memory and 2 cpus, with the model token in ${join(home, '.aeolus', 'trierarch', 'model-token')}.`);
  });

  it('gives the command line of a session in a container headless, as on the host: Claude Code in print mode with streamed JSON, the prompt sent on its stdin (headless H18)', async () => {
    configured({ ...SESSIONS, runtime: CONTAINER });

    const report = await configCheck(paths, { files: FILES, host });

    const words = (report.harnesses['claude-code']?.firstStart ?? []).flatMap((part) => part.words);
    expect({ headless: words.slice(1, 6), hasPrompt: words.includes('--') }).toEqual({ headless: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json'], hasPrompt: false });
  });

  it.each([
    { label: 'on the host', runtime: undefined },
    { label: 'in containers', runtime: CONTAINER },
  ])('asks for no tmux with the sessions $label: no session runs in a terminal (headless H4)', async ({ runtime }) => {
    configured({ ...SESSIONS, ...(runtime !== undefined && { runtime }) });

    const report = await configCheck(paths, { files: FILES, host });

    expect(report.text).not.toMatch(/tmux/iu);
  });

  it('refuses a configuration the container runtime cannot run, giving every reason', async () => {
    configured({ ...SESSIONS, runtime: CONTAINER });
    host.groups = ['docker'];
    host.hasModelToken = false;

    const refused = await configCheck(paths, { files: FILES, host }).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(TrierarchFileError);
    expect(refused instanceof Error ? refused.message.split('\n') : []).toEqual([
      `The configuration at ${paths.config} cannot run its sessions in containers:`,
      '  the user that runs the trierarch is in the docker group, which is root on the machine: take the user out of it',
      `  the model token file ${join(home, '.aeolus', 'trierarch', 'model-token')} is missing or empty: write the token claude setup-token gives into it, readable by its owner only`,
    ]);
  });
});

describe('config check, with the place of ships/', () => {
  /** A place for ships/ long enough that a ship's socket path in it is over 108 bytes, Linux's limit. */
  const aLongPlace = (): string => join(home, 'a-place-of-ships-far-too-long-for-a-socket-path-on-any-system-at-all');

  it("refuses a place where a ship's socket path would pass the system's limit, naming the setting to shorten", () => {
    const at = trierarchPaths({ homeDirectory: '/home/me' });
    // 106 bytes: past macOS's 104, under Linux's 108.
    const place = `/home/me/${'p'.repeat(47)}`;
    const socket = `${place}/shp_00000000000000000000000000/sockets/fleet.sock`;

    const refusals = ['darwin', 'linux'].map((platform) => checkShipsPlace({ paths: at, shipsRoot: place, platform })?.message);

    expect(refusals).toEqual([
      `The configuration at /home/me/.aeolus/trierarch/config.json keeps the ships' files in ${place}, where a ship's socket path, as ${socket}, is 106 bytes, past the system's limit of 104: name a shorter place in shipsRoot`,
      undefined,
    ]);
  });

  it("takes ships/ in the trierarch's folder of a short home on every system", () => {
    expect(checkShipsPlace({ paths: trierarchPaths({ homeDirectory: '/home/me' }), platform: 'darwin' })).toBeUndefined();
  });

  it("refuses the configuration's own place when it is too long", async () => {
    configured({ ...SESSIONS, shipsRoot: aLongPlace() });

    await expect(configCheck(paths, { files: FILES, host })).rejects.toThrow(`keeps the ships' files in ${aLongPlace()}, where a ship's socket path`);
  });
});
