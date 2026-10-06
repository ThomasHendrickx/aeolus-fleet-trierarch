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
 * mode. Both answers live in Claude Code's own files, which this changes key
 * by key, keeping everything else and the file's mode.
 */
export interface ClaudeCodeSetup {
  trust(folder: string): Promise<void>;
  isTrusted(folder: string): Promise<boolean>;
  acceptSkipPermissions(): Promise<void>;
  isSkipPermissionsAccepted(): Promise<boolean>;
}

const jsonObjectSchema = z.record(z.string(), z.unknown());
type JsonObject = z.infer<typeof jsonObjectSchema>;

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
    acceptSkipPermissions: async () => {
      await writeJsonObject(settings, { ...(await readJsonObject(settings)), skipDangerousModePermissionPrompt: true });
    },
    isSkipPermissionsAccepted: async () => (await readJsonObject(settings)).skipDangerousModePermissionPrompt === true,
  };
}
