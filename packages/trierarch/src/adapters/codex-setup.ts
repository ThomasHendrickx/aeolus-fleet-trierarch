import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { z } from 'zod';

import { runningVersion } from './version.js';

/**
 * Codex's one-time questions, answered ahead so a session nobody watches never
 * waits on one. Codex asks whether to trust a folder on its first start there;
 * trusting a repository covers its worktrees, but trusting a parent folder
 * covers no repository under it, so each configured repository and folder is
 * trusted. It asks to review hooks that are new or changed, and runs none it
 * does not trust, so the aeolus plugin's hooks (the turn marker among them)
 * are trusted too. Both answers go through Codex's own app server, as its
 * dialogs give them: the hash a hook is trusted by is Codex's to compute.
 */
export interface CodexSetup {
  trust(folders: readonly string[]): Promise<void>;
  /** Trusts the aeolus plugin's hooks that are new or changed, as Codex sees them from the folder: their keys. */
  trustAeolusHooks(folder: string): Promise<readonly string[]>;
}

const AEOLUS_PLUGIN_PREFIX = 'aeolus@';

/** How long the app server may take to answer before the setup gives up. */
const ANSWER_TIMEOUT_MS = 30_000;

const answerSchema = z.object({
  id: z.number(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});

const hooksListSchema = z.object({
  data: z.array(
    z.object({
      hooks: z.array(z.object({ key: z.string(), pluginId: z.string().nullish(), currentHash: z.string(), trustStatus: z.string() })),
    }),
  ),
});

/** A line the app server printed, as JSON; anything else is no answer. */
function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

type Request = (method: string, params: unknown) => Promise<unknown>;

/**
 * Runs `codex app-server` for one conversation: introduces itself, lets `talk`
 * send its requests, one answer each, and ends the server after.
 */
async function withAppServer<T>(command: string, talk: (request: Request) => Promise<T>): Promise<T> {
  const child = spawn(command, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const failed = new Promise<never>((_resolve, reject) => {
    child.on('error', (error) => {
      reject(new Error(`Codex is not installed, or ${command} does not run: ${error.message}`));
    });
    child.on('exit', (code) => {
      reject(new Error(`codex app-server ended before it answered (exit ${String(code)})`));
    });
    // An app server that ends before it reads what it is sent fails the write (EPIPE): a failed setup, not a crash.
    child.stdin.on('error', (error) => {
      reject(new Error(`codex app-server ended before it read what it was sent: ${error.message}`));
    });
  });
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; method: string }>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const parsed = answerSchema.safeParse(parseJson(line));
    const waiter = parsed.success ? waiting.get(parsed.data.id) : undefined;
    if (!parsed.success || waiter === undefined) {
      return;
    }
    waiting.delete(parsed.data.id);
    if (parsed.data.error === undefined) {
      waiter.resolve(parsed.data.result);
    } else {
      waiter.reject(new Error(`${waiter.method}: ${parsed.data.error.message}`));
    }
  });
  let nextId = 0;
  const send = (message: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };
  const request: Request = async (method, params) => {
    nextId += 1;
    const id = nextId;
    const answered = new Promise<unknown>((resolve, reject) => {
      waiting.set(id, { resolve, reject, method });
    });
    send({ id, method, params });
    const timeout = new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error(`codex app-server did not answer ${method}`));
      }, ANSWER_TIMEOUT_MS).unref();
    });
    return Promise.race([answered, failed, timeout]);
  };

  try {
    await request('initialize', { clientInfo: { name: 'aeolus-trierarch', version: runningVersion() } });
    send({ method: 'initialized' });
    return await talk(request);
  } finally {
    child.removeAllListeners('exit');
    failed.catch(() => undefined);
    child.kill();
  }
}

function upsert(keyPath: string, value: Record<string, unknown>): Record<string, unknown> {
  return { edits: [{ keyPath, value, mergeStrategy: 'upsert' }], reloadUserConfig: true };
}

export function createCodexSetup(options: { command?: string } = {}): CodexSetup {
  const command = options.command ?? 'codex';

  return {
    trust: async (folders) => {
      await withAppServer(command, (request) => request('config/batchWrite', upsert('projects', Object.fromEntries(folders.map((folder) => [folder, { trust_level: 'trusted' }])))));
    },
    trustAeolusHooks: async (folder) =>
      withAppServer(command, async (request) => {
        const listed = hooksListSchema.parse(await request('hooks/list', { cwds: [folder] }));
        const untrusted = listed.data
          .flatMap((entry) => entry.hooks)
          .filter((hook) => hook.pluginId?.startsWith(AEOLUS_PLUGIN_PREFIX) === true && (hook.trustStatus === 'untrusted' || hook.trustStatus === 'modified'));
        if (untrusted.length > 0) {
          await request('config/batchWrite', upsert('hooks.state', Object.fromEntries(untrusted.map((hook) => [hook.key, { trusted_hash: hook.currentHash }]))));
        }
        return untrusted.map((hook) => hook.key);
      }),
  };
}

/** A `[projects."<path>"]` or `[projects.'<path>']` table header in Codex's config.toml, as Codex writes it. */
const PROJECT_HEADER = /^\s*\[\s*projects\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]\s*$/;
const TABLE_HEADER = /^\s*\[/;
const TRUSTED_LEVEL = /^\s*trust_level\s*=\s*(?:"trusted"|'trusted')\s*(?:#.*)?$/;

/**
 * The folders Codex trusts (#381), read from its config.toml in CODEX_HOME,
 * or ~/.codex without it: each `projects` table whose `trust_level` is
 * `trusted`. None where Codex keeps no configuration yet.
 */
export async function codexTrustedFolders(at: { homeDirectory: string; env: Readonly<Record<string, string | undefined>> }): Promise<ReadonlySet<string>> {
  let text: string;
  try {
    text = await readFile(join(at.env.CODEX_HOME ?? join(at.homeDirectory, '.codex'), 'config.toml'), 'utf8');
  } catch {
    return new Set();
  }
  const trusted = new Set<string>();
  let project: string | undefined;
  for (const line of text.split('\n')) {
    const header = PROJECT_HEADER.exec(line);
    if (header !== null) {
      // A basic string's escapes read as JSON's do; a literal string has none.
      project = header[1] === undefined ? header[2] : z.string().parse(JSON.parse(`"${header[1]}"`));
    } else if (TABLE_HEADER.test(line)) {
      project = undefined;
    } else if (project !== undefined && TRUSTED_LEVEL.test(line)) {
      trusted.add(project);
    }
  }
  return trusted;
}
