import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

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
 * file's mode. It reads the default permission mode its settings give a
 * folder, so a crewed session is never started in plan mode (#505, #507). Its
 * files follow CLAUDE_CONFIG_DIR when it is set, as Claude Code's do (#474).
 */
export interface ClaudeCodeSetup {
  /** The files it answers in: `.claude.json` and the user's `settings.json`, where Claude Code keeps them. */
  readonly files: { readonly claudeJson: string; readonly settings: string };
  trust(folder: string): Promise<void>;
  isTrusted(folder: string): Promise<boolean>;
  /** Every folder it trusts, from one read of its file (#381). */
  trustedFolders(): Promise<ReadonlySet<string>>;
  acceptSkipPermissions(): Promise<void>;
  isSkipPermissionsAccepted(): Promise<boolean>;
  completeOnboarding(): Promise<void>;
  isOnboardingComplete(): Promise<boolean>;
  /**
   * The `permissions.defaultMode` Claude Code takes from its settings files,
   * the first that names one: the managed settings, the `--settings` file or
   * JSON, then of the sources it loads the folder's local settings, its
   * project's and the user's. Without a folder it is decided only when no
   * folder settings come before the one that names it.
   */
  defaultPermissionMode(at: { folder?: string; settings?: string; sources: readonly SettingSource[] }): Promise<SettingsDefaultMode>;
}

/** The settings files `--setting-sources` picks from. */
export type SettingSource = 'user' | 'project' | 'local';

/** The settings sources, the one Claude Code takes first. */
export const SETTING_SOURCES: readonly SettingSource[] = ['local', 'project', 'user'];

/** A default mode the settings decide, possibly none; or one the settings of each folder decide. */
export type SettingsDefaultMode = { kind: 'decided'; mode: string | undefined } | { kind: 'per folder' };

/** Where Claude Code reads its managed settings files on macOS and on Linux; only the command itself reads it, so no test reads the machine's own (#516). */
export const CLAUDE_CODE_MANAGED_SETTINGS = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : '/etc/claude-code';

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

/** Settings' `permissions.defaultMode`, or none when they are no JSON or name none: Claude Code reports broken settings itself. */
function defaultModeOf(text: string): string | undefined {
  try {
    const settings = jsonObjectSchema.parse(JSON.parse(text));
    return z.object({ defaultMode: z.string() }).safeParse(settings.permissions).data?.defaultMode;
  } catch {
    return undefined;
  }
}

/** A settings file's default mode, or none when the file is missing. */
async function defaultModeIn(path: string): Promise<string | undefined> {
  const text = await readFile(path, 'utf8').catch(() => undefined);
  return text === undefined ? undefined : defaultModeOf(text);
}

/** The managed settings' default mode: managed-settings.json, then each visible `.json` in managed-settings.d in alphabetical order, the last that names one winning. */
async function managedDefaultMode(folder: string): Promise<string | undefined> {
  const dropIns = join(folder, 'managed-settings.d');
  const files = (await readdir(dropIns).catch(() => [])).filter((file) => file.endsWith('.json') && !file.startsWith('.')).sort();
  const modes = await Promise.all([join(folder, 'managed-settings.json'), ...files.map((file) => join(dropIns, file))].map(defaultModeIn));
  return modes.findLast((mode) => mode !== undefined);
}

/** `--settings` takes a file or JSON; a relative file is the folder's, so without a folder it is unknown. */
async function commandLineDefaultMode(settings: string, folder: string | undefined): Promise<string | undefined> {
  if (settings.trimStart().startsWith('{')) {
    return defaultModeOf(settings);
  }
  if (isAbsolute(settings)) {
    return defaultModeIn(settings);
  }
  return folder === undefined ? undefined : defaultModeIn(join(folder, settings));
}

async function writeJsonObject(path: string, value: JsonObject): Promise<void> {
  const mode = (await stat(path).catch(() => undefined))?.mode ?? PRIVATE_MODE;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.aeolus-trierarch.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: mode & 0o777 });
  await rename(temporary, path);
}

export function createClaudeCodeSetup(at: {
  homeDirectory: string;
  /** Claude Code's configuration folder, CLAUDE_CONFIG_DIR when set, where it keeps the user's settings and .claude.json; ~/.claude by default, with .claude.json in the home folder. */
  configDirectory?: string;
  /** Where Claude Code reads its managed settings files: CLAUDE_CODE_MANAGED_SETTINGS on the machine, a folder of its own in a test. */
  managedSettings: string;
}): ClaudeCodeSetup {
  // As Claude Code does: .claude.json in CLAUDE_CONFIG_DIR when it is set, else in the home folder beside ~/.claude (#474).
  const state = join(at.configDirectory ?? at.homeDirectory, '.claude.json');
  const settings = join(at.configDirectory ?? join(at.homeDirectory, '.claude'), 'settings.json');
  const projectsOf = (claude: JsonObject): JsonObject => jsonObjectSchema.safeParse(claude.projects).data ?? {};
  const fullscreenOfferSeen = (claude: JsonObject): number => z.number().safeParse(claude.fullscreenUpsellSeenCount).data ?? 0;

  return {
    files: { claudeJson: state, settings },
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
    defaultPermissionMode: async ({ folder, settings: commandLine, sources }) => {
      const above = (await managedDefaultMode(at.managedSettings)) ?? (commandLine === undefined ? undefined : await commandLineDefaultMode(commandLine, folder));
      if (above !== undefined) {
        return { kind: 'decided', mode: above };
      }
      const fileOf = (source: SettingSource): string | undefined =>
        source === 'user' ? settings : folder === undefined ? undefined : join(folder, '.claude', source === 'local' ? 'settings.local.json' : 'settings.json');
      for (const source of SETTING_SOURCES.filter((source) => sources.includes(source))) {
        const file = fileOf(source);
        if (file === undefined) {
          return { kind: 'per folder' };
        }
        const mode = await defaultModeIn(file);
        if (mode !== undefined) {
          return { kind: 'decided', mode };
        }
      }
      return { kind: 'decided', mode: undefined };
    },
  };
}
