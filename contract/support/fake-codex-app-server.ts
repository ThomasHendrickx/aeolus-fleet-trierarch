/**
 * A stand-in for `codex app-server`, run by Node as a program: one JSON-RPC
 * message per line on stdin, one answer per request on stdout, as Codex
 * answers the requests the trierarch makes of it. `config/batchWrite` of
 * `projects` writes each folder trusted into config.toml in CODEX_HOME or
 * ~/.codex, as Codex keeps it, and of `hooks.state` each hook's trusted hash;
 * `hooks/list` answers no hook to trust, or one untrusted aeolus-fleet hook
 * with FAKE_CODEX_UNTRUSTED_HOOK set; anything else answers an empty result.
 * It ends when stdin closes.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { z } from 'zod';

const requestSchema = z.object({ id: z.number().optional(), method: z.string(), params: z.unknown().optional() });
const projectsSchema = z.object({ edits: z.array(z.object({ keyPath: z.string(), value: z.record(z.string(), z.unknown()) })) });

const hashSchema = z.object({ trusted_hash: z.string() });

/** The aeolus-fleet hook Codex lists as new, so not trusted yet. */
const UNTRUSTED_HOOK = { key: 'aeolus-fleet@aeolus-fleet:hooks/hooks.json:stop:0:0', pluginId: 'aeolus-fleet@aeolus-fleet', currentHash: 'sha256:5f1d', trustStatus: 'untrusted' };

const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');

function answerOf(method: string, params: unknown): unknown {
  if (method === 'hooks/list') {
    return { data: process.env.FAKE_CODEX_UNTRUSTED_HOOK === '1' ? [{ hooks: [UNTRUSTED_HOOK] }] : [] };
  }
  if (method === 'config/batchWrite') {
    const edits = projectsSchema.safeParse(params).data?.edits ?? [];
    const folders = edits.filter((edit) => edit.keyPath === 'projects').flatMap((edit) => Object.keys(edit.value));
    const hooks = edits.filter((edit) => edit.keyPath === 'hooks.state').flatMap((edit) => Object.entries(edit.value));
    mkdirSync(codexHome, { recursive: true });
    appendFileSync(
      join(codexHome, 'config.toml'),
      [
        ...folders.map((folder) => `\n[projects.${JSON.stringify(folder)}]\ntrust_level = "trusted"\n`),
        ...hooks.map(([key, state]) => `\n[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = ${JSON.stringify(hashSchema.safeParse(state).data?.trusted_hash ?? '')}\n`),
      ].join(''),
    );
  }
  return {};
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const request = requestSchema.safeParse(JSON.parse(line));
  if (request.success && request.data.id !== undefined) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.data.id, result: answerOf(request.data.method, request.data.params) })}\n`);
  }
});
