import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
