import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TrierarchConfiguration } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTrust } from './trust.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aeolus-trust-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const AEOLUS_FLEET = '/home/thomas/Projects/aeolus-fleet';
const PAGASAE = '/home/thomas/Projects/pagasae';
const NOTES = '/home/thomas/notes';
const SKIP = '--dangerously-skip-permissions';

const configuration: TrierarchConfiguration = {
  caps: { ships: 4, running: 2 },
  repositories: { 'aeolus-fleet': { path: AEOLUS_FLEET }, pagasae: { path: PAGASAE } },
  folders: { notes: { path: NOTES } },
  harnesses: { 'claude-code': { flags: [], options: {} }, codex: { flags: [], options: {} } },
};

function claudeJson(projects: Record<string, unknown>): void {
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ numStartups: 3, projects }));
}

function codexToml(folder: string, text: string): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'config.toml'), text);
}

describe("each harness's trust, read from its own files (#381)", () => {
  it("answers the repositories and folders Claude Code trusts, by name, from ~/.claude.json", async () => {
    claudeJson({ [AEOLUS_FLEET]: { hasTrustDialogAccepted: true }, [PAGASAE]: { hasTrustDialogAccepted: false }, [NOTES]: { hasTrustDialogAccepted: true } });

    const trusted = await createTrust({ configuration: { ...configuration, harnesses: { 'claude-code': { flags: [], options: {} } } }, homeDirectory: home, env: {} }).trusted();

    expect(trusted).toEqual({ 'claude-code': { repositories: ['aeolus-fleet'], folders: ['notes'], unacceptedFlags: [SKIP] } });
  });

  it("answers the places Codex trusts from its config.toml, in either quoting, and nothing for a place whose trust level is another", async () => {
    codexToml(
      join(home, '.codex'),
      [
        'model = "gpt-6"',
        '',
        `[projects."${AEOLUS_FLEET}"]`,
        'trust_level = "trusted"',
        '',
        `[projects.'${NOTES}']`,
        "trust_level = 'trusted'",
        '',
        `[projects."${PAGASAE}"]`,
        'trust_level = "untrusted"',
        '',
      ].join('\n'),
    );
    claudeJson({});

    const trusted = await createTrust({ configuration, homeDirectory: home, env: {} }).trusted();

    expect(trusted).toEqual({ 'claude-code': { repositories: [], folders: [], unacceptedFlags: [SKIP] }, codex: { repositories: ['aeolus-fleet'], folders: ['notes'], unacceptedFlags: [] } });
  });

  it('reads Codex from CODEX_HOME when it is set', async () => {
    const codexHome = join(home, 'codex-home');
    codexToml(codexHome, `[projects."${PAGASAE}"]\ntrust_level = "trusted"\n`);

    const trusted = await createTrust({ configuration, homeDirectory: home, env: { CODEX_HOME: codexHome } }).trusted();

    expect(trusted.codex).toEqual({ repositories: ['pagasae'], folders: [], unacceptedFlags: [] });
  });

  it("answers Claude Code's skip-permissions flag as unaccepted until bypass permissions mode is accepted in ~/.claude/settings.json (#403)", async () => {
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }));

    const trusted = await createTrust({ configuration, homeDirectory: home, env: {} }).trusted();

    expect(trusted['claude-code']?.unacceptedFlags).toEqual([]);
  });

  it('trusts nothing where a harness has no files yet', async () => {
    const trusted = await createTrust({ configuration, homeDirectory: home, env: {} }).trusted();

    expect(trusted).toEqual({ 'claude-code': { repositories: [], folders: [], unacceptedFlags: [SKIP] }, codex: { repositories: [], folders: [], unacceptedFlags: [] } });
  });
});
