import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPluginUpdate } from './plugin-update.js';

// Against stand-ins for `codex` and `claude`: each logs the words it runs with.
// The Codex one does what Codex's own plugin upgrade does (#581): it installs
// the new version and deletes every other version folder.

let home: string;
let log: string;
let codex: string;
let claude: string;

function codexCache(codexHome = join(home, '.codex')): string {
  return join(codexHome, 'plugins', 'cache', 'aeolus-fleet', 'aeolus');
}

/** A version of the aeolus plugin for Codex, as Codex installs it, with a script a running session uses. */
function aCodexVersion(version: string, cache = codexCache()): void {
  mkdirSync(join(cache, version, 'scripts'), { recursive: true });
  writeFileSync(join(cache, version, 'scripts', 'aeolus-fleet.sh'), `# ${version}\n`);
}

/** A stand-in program: logs its words, then runs `then` (JavaScript) and exits with `status`, printing `stderr`. */
function aProgram(path: string, at: { then?: string; status?: number; stderr?: string } = {}): void {
  writeFileSync(
    path,
    `#!/usr/bin/env node
const { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
appendFileSync(${JSON.stringify(log)}, require('node:path').basename(process.argv[1]) + ' ' + process.argv.slice(2).join(' ') + '\\n');
${at.then ?? ''}
process.stderr.write(${JSON.stringify(at.stderr ?? '')});
process.exit(${String(at.status ?? 0)});
`,
  );
  chmodSync(path, 0o700);
}

/** Codex's own plugin upgrade: the new version in, every other version folder deleted. */
function codexUpgrading(to: string, cache = codexCache()): string {
  return `const cache = ${JSON.stringify(cache)};
for (const name of readdirSync(cache)) rmSync(join(cache, name), { recursive: true });
mkdirSync(join(cache, ${JSON.stringify(to)}, 'scripts'), { recursive: true });
writeFileSync(join(cache, ${JSON.stringify(to)}, 'scripts', 'aeolus-fleet.sh'), '# ${to}\\n');`;
}

function ran(): string[] {
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((line) => line !== '') : [];
}

function update(env: Record<string, string> = {}) {
  return createPluginUpdate({ homeDirectory: home, env, commands: { codex, 'claude-code': claude } });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aeolus-plugin-update-'));
  log = join(home, 'ran.log');
  codex = join(home, 'codex');
  claude = join(home, 'claude');
  aProgram(claude);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('the aeolus plugin update for Codex', () => {
  it("runs Codex's own plugin upgrade for the aeolus-fleet marketplace", async () => {
    aCodexVersion('0.21.0');
    aProgram(codex, { then: codexUpgrading('0.22.0') });

    await update().update('codex');

    expect(ran()).toEqual(['codex plugin marketplace upgrade aeolus-fleet']);
  });

  it('keeps the version folders running Codex sessions use beside the new one, as they were (#581)', async () => {
    aCodexVersion('0.21.0');
    aProgram(codex, { then: codexUpgrading('0.22.0') });

    await update().update('codex');

    expect(readdirSync(codexCache()).sort()).toEqual(['0.21.0', '0.22.0']);
    expect(readFileSync(join(codexCache(), '0.21.0', 'scripts', 'aeolus-fleet.sh'), 'utf8')).toBe('# 0.21.0\n');
  });

  it("puts the version folders running sessions use back when Codex's upgrade fails, saying what Codex said (#581)", async () => {
    aCodexVersion('0.21.0');
    aProgram(codex, { then: `rmSync(join(${JSON.stringify(codexCache())}, '0.21.0'), { recursive: true });`, status: 1, stderr: 'Error: could not reach github.com\n' });

    await expect(update().update('codex')).rejects.toThrow('codex plugin marketplace upgrade aeolus-fleet failed: Error: could not reach github.com');
    expect(readFileSync(join(codexCache(), '0.21.0', 'scripts', 'aeolus-fleet.sh'), 'utf8')).toBe('# 0.21.0\n');
  });

  it('keeps the versions in the plugin folders of CODEX_HOME when it is set', async () => {
    const codexHome = join(home, 'elsewhere');
    aCodexVersion('0.21.0', codexCache(codexHome));
    aProgram(codex, { then: codexUpgrading('0.22.0', codexCache(codexHome)) });

    await update({ CODEX_HOME: codexHome }).update('codex');

    expect(readdirSync(codexCache(codexHome)).sort()).toEqual(['0.21.0', '0.22.0']);
  });

  it('runs the upgrade where Codex has no aeolus plugin version yet', async () => {
    aProgram(codex);

    await update().update('codex');

    expect(ran()).toEqual(['codex plugin marketplace upgrade aeolus-fleet']);
  });
});

describe('the aeolus plugin update for Claude Code', () => {
  it("updates Claude Code's aeolus-fleet marketplace, then the aeolus plugin from it", async () => {
    await update().update('claude-code');

    expect(ran()).toEqual(['claude plugin marketplace update aeolus-fleet', 'claude plugin update aeolus@aeolus-fleet']);
  });

  it('says what Claude Code said when its update fails', async () => {
    aProgram(claude, { status: 1, stderr: 'Plugin "aeolus@aeolus-fleet" is not installed\n' });

    await expect(update().update('claude-code')).rejects.toThrow('claude plugin marketplace update aeolus-fleet failed: Plugin "aeolus@aeolus-fleet" is not installed');
  });
});
