import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { TrierarchFileError } from './files.js';

/**
 * Claude Code's one-time questions, answered ahead so a session nobody
 * watches never waits on one. Claude Code asks whether to trust a folder on
 * its first start there, even with `--dangerously-skip-permissions`; trusting
 * a folder covers every folder under it, so trusting the worktree root covers
 * every worktree. It asks once per user whether to accept bypass permissions
 * mode. On a machine where it never ran by hand it shows its onboarding (the
 * theme, the login, the security notes) and later offers its fullscreen
 * renderer (#403); a completed onboarding skips the first, and an offer seen
 * as often as it is shown skips the second. The answers live in Claude Code's
 * own files, which this changes key by key, keeping everything else and the
 * file's mode.
 */
export interface ClaudeCodeSetup {
  trust(folder: string): Promise<void>;
  isTrusted(folder: string): Promise<boolean>;
  /** Every folder it trusts, from one read of its file (#381). */
  trustedFolders(): Promise<ReadonlySet<string>>;
  acceptSkipPermissions(): Promise<void>;
  isSkipPermissionsAccepted(): Promise<boolean>;
  completeOnboarding(): Promise<void>;
  isOnboardingComplete(): Promise<boolean>;
}

const jsonObjectSchema = z.record(z.string(), z.unknown());
type JsonObject = z.infer<typeof jsonObjectSchema>;

/** How often Claude Code 2.1.295 offers its fullscreen renderer at most: once seen this often, it offers it no more. */
const FULLSCREEN_OFFER_SHOWN_MAX = 3;

/** A file only its user reads, as Claude Code keeps ~/.claude.json. */
const PRIVATE_MODE = 0o600;

async function readJsonObject(path: string): Promise<JsonObject> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return {};
  }
  try {
    return jsonObjectSchema.parse(JSON.parse(text));
  } catch {
    throw new TrierarchFileError(`${path} is no JSON object: fix it by hand, then run this again`);
  }
}

async function writeJsonObject(path: string, value: JsonObject): Promise<void> {
  const mode = (await stat(path).catch(() => undefined))?.mode ?? PRIVATE_MODE;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.aeolus-trierarch.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: mode & 0o777 });
  await rename(temporary, path);
}

export function createClaudeCodeSetup(at: { homeDirectory: string }): ClaudeCodeSetup {
  const state = join(at.homeDirectory, '.claude.json');
  const settings = join(at.homeDirectory, '.claude', 'settings.json');
  const projectsOf = (claude: JsonObject): JsonObject => jsonObjectSchema.safeParse(claude.projects).data ?? {};
  const fullscreenOfferSeen = (claude: JsonObject): number => z.number().safeParse(claude.fullscreenUpsellSeenCount).data ?? 0;

  return {
    trust: async (folder) => {
      const claude = await readJsonObject(state);
      const projects = projectsOf(claude);
      const project = jsonObjectSchema.safeParse(projects[folder]).data ?? {};
      await writeJsonObject(state, { ...claude, projects: { ...projects, [folder]: { ...project, hasTrustDialogAccepted: true } } });
    },
    isTrusted: async (folder) => {
      const project = jsonObjectSchema.safeParse(projectsOf(await readJsonObject(state))[folder]).data;
      return project?.hasTrustDialogAccepted === true;
    },
    trustedFolders: async () => {
      const projects = Object.entries(projectsOf(await readJsonObject(state)));
      return new Set(projects.filter(([, project]) => jsonObjectSchema.safeParse(project).data?.hasTrustDialogAccepted === true).map(([folder]) => folder));
    },
    acceptSkipPermissions: async () => {
      await writeJsonObject(settings, { ...(await readJsonObject(settings)), skipDangerousModePermissionPrompt: true });
    },
    isSkipPermissionsAccepted: async () => (await readJsonObject(settings)).skipDangerousModePermissionPrompt === true,
    completeOnboarding: async () => {
      const claude = await readJsonObject(state);
      await writeJsonObject(state, { ...claude, hasCompletedOnboarding: true, fullscreenUpsellSeenCount: Math.max(fullscreenOfferSeen(claude), FULLSCREEN_OFFER_SHOWN_MAX) });
    },
    isOnboardingComplete: async () => {
      const claude = await readJsonObject(state);
      return claude.hasCompletedOnboarding === true && fullscreenOfferSeen(claude) >= FULLSCREEN_OFFER_SHOWN_MAX;
    },
  };
}
