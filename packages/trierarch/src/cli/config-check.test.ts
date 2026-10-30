import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TrierarchConfiguration } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIGURATION, InMemoryContainerHost } from '../../test/support/in-memory.js';
import { TrierarchFileError } from '../adapters/files.js';
import { trierarchPaths, type TrierarchPaths } from '../adapters/paths.js';
import { configCheck } from './config-check.js';

const CONTAINER = { kind: 'container', binary: 'podman', memory: '4g', cpus: 2 } as const;
/** What config check reads of Claude Code's own files: nothing makes plan its default mode. */
const FILES = { claudeCode: { defaultPermissionMode: () => Promise.resolve({ kind: 'decided' as const, mode: undefined }) } };

let home: string;
let paths: TrierarchPaths;
let host: InMemoryContainerHost;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'trierarch-config-check-'));
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
