import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClaudeCodeSetup } from './claude-code-setup.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'trierarch-claude-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const claudeJson = () => join(home, '.claude.json');
const settingsJson = () => join(home, '.claude', 'settings.json');
const read = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

describe("Claude Code's one-time questions, answered ahead", () => {
  it('trusts a folder, so Claude Code asks nothing there or in any folder under it, keeping everything else in ~/.claude.json and its mode', async () => {
    writeFileSync(claudeJson(), JSON.stringify({ numStartups: 7, projects: { '/elsewhere': { hasTrustDialogAccepted: false, history: [] } } }), { mode: 0o600 });

    await createClaudeCodeSetup({ homeDirectory: home, managedSettings: join(home, 'managed') }).trust('/Users/thomas/.aeolus/trierarch/worktrees');

    expect(read(claudeJson())).toEqual({
      numStartups: 7,
      projects: {
        '/elsewhere': { hasTrustDialogAccepted: false, history: [] },
        '/Users/thomas/.aeolus/trierarch/worktrees': { hasTrustDialogAccepted: true },
      },
    });
    expect(statSync(claudeJson()).mode & 0o777).toBe(0o600);
  });

  it('keeps what Claude Code holds about a folder it trusts', async () => {
    writeFileSync(claudeJson(), JSON.stringify({ projects: { '/root': { allowedTools: ['Bash'] } } }));

    await createClaudeCodeSetup({ homeDirectory: home, managedSettings: join(home, 'managed') }).trust('/root');

    expect(read(claudeJson())).toEqual({ projects: { '/root': { allowedTools: ['Bash'], hasTrustDialogAccepted: true } } });
  });

  it('writes ~/.claude.json, readable by its user only, when there is none yet', async () => {
    await createClaudeCodeSetup({ homeDirectory: home, managedSettings: join(home, 'managed') }).trust('/root');

    expect(read(claudeJson())).toEqual({ projects: { '/root': { hasTrustDialogAccepted: true } } });
    expect(statSync(claudeJson()).mode & 0o777).toBe(0o600);
  });

  it('says whether a folder is trusted', async () => {
    const setup = createClaudeCodeSetup({ homeDirectory: home, managedSettings: join(home, 'managed') });
    await expect(setup.isTrusted('/root')).resolves.toBe(false);

    await setup.trust('/root');

    await expect(setup.isTrusted('/root')).resolves.toBe(true);
  });

  it('refuses to touch a ~/.claude.json that is no JSON', async () => {
    writeFileSync(claudeJson(), '{ broken');

    await expect(createClaudeCodeSetup({ homeDirectory: home, managedSettings: join(home, 'managed') }).trust('/root')).rejects.toThrow(`${claudeJson()} is no JSON`);
    expect(readFileSync(claudeJson(), 'utf8')).toBe('{ broken');
  });

  it('accepts bypass permissions mode once for the user, keeping the other settings', async () => {
    mkdirSync(join(home, '.claude'));
    writeFileSync(settingsJson(), JSON.stringify({ model: 'opus', permissions: { defaultMode: 'auto' } }));
    const setup = createClaudeCodeSetup({ homeDirectory: home, managedSettings: join(home, 'managed') });
    await expect(setup.isSkipPermissionsAccepted()).resolves.toBe(false);

    await setup.acceptSkipPermissions();

    expect(read(settingsJson())).toEqual({ model: 'opus', permissions: { defaultMode: 'auto' }, skipDangerousModePermissionPrompt: true });
    await expect(setup.isSkipPermissionsAccepted()).resolves.toBe(true);
  });

  it('accepts bypass permissions mode when there are no settings yet', async () => {
    await createClaudeCodeSetup({ homeDirectory: home, managedSettings: join(home, 'managed') }).acceptSkipPermissions();

    expect(read(settingsJson())).toEqual({ skipDangerousModePermissionPrompt: true });
  });

  it('completes the onboarding, so a fresh machine shows no first-run screen, keeping everything else in ~/.claude.json and its mode', async () => {
    writeFileSync(claudeJson(), JSON.stringify({ numStartups: 7, projects: { '/root': { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
    const setup = createClaudeCodeSetup({ homeDirectory: home, managedSettings: join(home, 'managed') });
    await expect(setup.isOnboardingComplete()).resolves.toBe(false);

    await setup.completeOnboarding();

    expect(read(claudeJson())).toEqual({ numStartups: 7, projects: { '/root': { hasTrustDialogAccepted: true } }, hasCompletedOnboarding: true, fullscreenUpsellSeenCount: 3 });
    expect(statSync(claudeJson()).mode & 0o777).toBe(0o600);
    await expect(setup.isOnboardingComplete()).resolves.toBe(true);
  });

  it('completes the onboarding when there is no ~/.claude.json yet', async () => {
    await createClaudeCodeSetup({ homeDirectory: home, managedSettings: join(home, 'managed') }).completeOnboarding();

    expect(read(claudeJson())).toEqual({ hasCompletedOnboarding: true, fullscreenUpsellSeenCount: 3 });
  });

  it('keeps a fullscreen renderer offer seen more often than it is shown', async () => {
    writeFileSync(claudeJson(), JSON.stringify({ hasCompletedOnboarding: true, fullscreenUpsellSeenCount: 5 }));

    await createClaudeCodeSetup({ homeDirectory: home, managedSettings: join(home, 'managed') }).completeOnboarding();

    expect(read(claudeJson())).toEqual({ hasCompletedOnboarding: true, fullscreenUpsellSeenCount: 5 });
  });

  it('sees the onboarding incomplete while the fullscreen renderer offer would still show', async () => {
    writeFileSync(claudeJson(), JSON.stringify({ hasCompletedOnboarding: true, fullscreenUpsellSeenCount: 2 }));

    await expect(createClaudeCodeSetup({ homeDirectory: home, managedSettings: join(home, 'managed') }).isOnboardingComplete()).resolves.toBe(false);
  });
});

describe("Claude Code's files under CLAUDE_CONFIG_DIR, where Claude Code keeps them when it is set (#474)", () => {
  const configDirectory = () => join(home, 'claude-config');

  it('trusts a folder and completes the onboarding in .claude.json under CLAUDE_CONFIG_DIR, leaving ~/.claude.json alone', async () => {
    const setup = createClaudeCodeSetup({ homeDirectory: home, configDirectory: configDirectory(), managedSettings: join(home, 'managed') });

    await setup.trust('/root');
    await setup.completeOnboarding();

    expect(read(join(configDirectory(), '.claude.json'))).toEqual({ projects: { '/root': { hasTrustDialogAccepted: true } }, hasCompletedOnboarding: true, fullscreenUpsellSeenCount: 3 });
    expect(existsSync(claudeJson())).toBe(false);
  });

  it('accepts bypass permissions mode in settings.json under CLAUDE_CONFIG_DIR, leaving ~/.claude/settings.json alone', async () => {
    const setup = createClaudeCodeSetup({ homeDirectory: home, configDirectory: configDirectory(), managedSettings: join(home, 'managed') });

    await setup.acceptSkipPermissions();

    expect(read(join(configDirectory(), 'settings.json'))).toEqual({ skipDangerousModePermissionPrompt: true });
    expect(existsSync(settingsJson())).toBe(false);
    await expect(setup.isSkipPermissionsAccepted()).resolves.toBe(true);
  });
});

describe('a key in reach of a subscription session (api keys K6)', () => {
  const setup = () => createClaudeCodeSetup({ homeDirectory: home, managedSettings: join(home, 'managed') });
  const ALL = { sources: ['local', 'project', 'user'] as const };

  it("finds none where Claude Code's settings name no key", async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(settingsJson(), JSON.stringify({ env: { DISABLE_TELEMETRY: '1' }, permissions: { defaultMode: 'acceptEdits' } }));

    await expect(setup().keyInReach({ ...ALL })).resolves.toBeUndefined();
  });

  it("names an apiKeyHelper in the user's settings, never what it runs", async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(settingsJson(), JSON.stringify({ apiKeyHelper: '/usr/local/bin/print-secret-key' }));

    const found = await setup().keyInReach({ ...ALL });

    expect(found).toBe(`apiKeyHelper in ${settingsJson()}`);
    expect(found).not.toContain('print-secret-key');
  });

  it("names a key variable in a folder's project settings, never its value", async () => {
    const folder = join(home, 'work');
    mkdirSync(join(folder, '.claude'), { recursive: true });
    writeFileSync(join(folder, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'test-key-not-real' } }));

    const found = await setup().keyInReach({ ...ALL, folder });

    expect(found).toBe(`ANTHROPIC_API_KEY in ${join(folder, '.claude', 'settings.json')}`);
    expect(found).not.toContain('test-key-not-real');
  });

  it('names a cloud provider variable in a managed settings drop-in', async () => {
    mkdirSync(join(home, 'managed', 'managed-settings.d'), { recursive: true });
    writeFileSync(join(home, 'managed', 'managed-settings.d', '10-cloud.json'), JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }));

    await expect(setup().keyInReach({ ...ALL })).resolves.toBe(`CLAUDE_CODE_USE_BEDROCK in ${join(home, 'managed', 'managed-settings.d', '10-cloud.json')}`);
  });

  it('names an ANTHROPIC_AUTH_TOKEN in the --settings JSON on the command line', async () => {
    await expect(setup().keyInReach({ ...ALL, settings: JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'x' } }) })).resolves.toBe('ANTHROPIC_AUTH_TOKEN in --settings');
  });

  it('reads only the sources Claude Code loads', async () => {
    const folder = join(home, 'work');
    mkdirSync(join(folder, '.claude'), { recursive: true });
    writeFileSync(join(folder, '.claude', 'settings.local.json'), JSON.stringify({ apiKeyHelper: 'helper' }));

    await expect(setup().keyInReach({ sources: ['user'], folder })).resolves.toBeUndefined();
  });
});
