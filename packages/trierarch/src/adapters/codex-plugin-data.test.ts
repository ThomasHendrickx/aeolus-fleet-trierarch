import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { codexKeepsPluginData } from './codex-plugin-data.js';
import { runCommand } from './run-command.js';

// The proof trierarch upgrade runs before it removes Codex's aeolus-fleet
// marketplace (#660): once against the real Codex on this machine, and against
// stand-ins for the Codex that would lose the data.

let folder: string;
let log: string;

/** A stand-in `codex`: logs its CODEX_HOME and words, runs `then` (JavaScript), and exits with `status`, printing `stderr`. */
function aCodex(at: { then?: string; status?: number; stderr?: string } = {}): string {
  const path = join(folder, 'codex');
  writeFileSync(
    path,
    `#!/usr/bin/env node
const { appendFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ home: process.env.CODEX_HOME, words: process.argv.slice(2).join(' ') }) + '\\n');
${at.then ?? ''}
process.stderr.write(${JSON.stringify(at.stderr ?? '')});
process.exit(${String(at.status ?? 0)});
`,
  );
  chmodSync(path, 0o700);
  return path;
}

const ranSchema = z.object({ home: z.string().optional(), words: z.string() });

/** What the stand-in ran, each with the CODEX_HOME it ran in. */
function ran(): z.infer<typeof ranSchema>[] {
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => ranSchema.parse(JSON.parse(line)));
}

/** The words of a Codex that deletes its plugins' data when a marketplace is removed. */
const DELETES_DATA_ON_REMOVE = "if (process.argv.slice(2).join(' ') === 'plugin marketplace remove aeolus-fleet') rmSync(join(process.env.CODEX_HOME, 'plugins', 'data'), { recursive: true, force: true });";

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'aeolus-codex-plugin-data-'));
  log = join(folder, 'ran.log');
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

const realCodex = await runCommand('codex', { args: ['--version'] }).catch(() => undefined);

describe('the real Codex on this machine', () => {
  it("keeps the aeolus plugin's data, its log and the crew identities not yet moved to ~/.aeolus/crews, when its aeolus-fleet marketplace is removed (#660)", async (context) => {
    if (realCodex?.status !== 0) {
      context.skip('no codex on this machine');
    }

    expect(await codexKeepsPluginData('codex')).toBe(true);
  }, 60_000);
});

describe("the proof that Codex keeps the aeolus plugin's data on marketplace remove", () => {
  it('fails for a Codex that deletes the plugin data when the aeolus-fleet marketplace is removed (#660)', async () => {
    expect(await codexKeepsPluginData(aCodex({ then: DELETES_DATA_ON_REMOVE }))).toBe(false);
  });

  it('holds for a Codex that keeps it (#660)', async () => {
    expect(await codexKeepsPluginData(aCodex())).toBe(true);
  });

  it('installs the aeolus plugin from an aeolus-fleet marketplace of its own, then removes that marketplace (#660)', async () => {
    await codexKeepsPluginData(aCodex());

    expect(ran().map(({ words }) => words.replace(/ \/\S+$/, ' <folder>'))).toEqual(['plugin marketplace add <folder>', 'plugin add aeolus@aeolus-fleet', 'plugin marketplace remove aeolus-fleet']);
  });

  it('runs Codex only in a throwaway CODEX_HOME, and removes it after (#660)', async () => {
    await codexKeepsPluginData(aCodex());

    const homes = new Set(ran().map(({ home }) => home));
    expect(homes.size).toBe(1);
    const [home] = homes;
    expect(home).not.toBe(process.env.CODEX_HOME);
    expect(home?.startsWith(tmpdir())).toBe(true);
    expect(existsSync(home ?? '')).toBe(false);
  });

  it('says what Codex said when it cannot run the proof (#660)', async () => {
    const codex = aCodex({ then: "if (process.argv.slice(2).join(' ') === 'plugin add aeolus@aeolus-fleet') { process.stderr.write('Error: plugin aeolus not found'); process.exit(1); }" });

    await expect(codexKeepsPluginData(codex)).rejects.toThrow('codex plugin add aeolus@aeolus-fleet failed: Error: plugin aeolus not found');
  });
});
