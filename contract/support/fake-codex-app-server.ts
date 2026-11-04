/**
 * A stand-in for `codex app-server`, run by Node as a program: one JSON-RPC
 * message per line on stdin, one answer per request on stdout, as Codex
 * answers the requests the trierarch makes of it. `config/batchWrite` of
 * `projects` writes each folder trusted into config.toml in CODEX_HOME or
 * ~/.codex, as Codex keeps it; `hooks/list` answers no hook to trust;
 * anything else answers an empty result. It ends when stdin closes.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { z } from 'zod';

const requestSchema = z.object({ id: z.number().optional(), method: z.string(), params: z.unknown().optional() });
const projectsSchema = z.object({ edits: z.array(z.object({ keyPath: z.string(), value: z.record(z.string(), z.unknown()) })) });

const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');

function answerOf(method: string, params: unknown): unknown {
  if (method === 'hooks/list') {
    return { data: [] };
  }
  if (method === 'config/batchWrite') {
    const edits = projectsSchema.safeParse(params).data?.edits ?? [];
    const folders = edits.filter((edit) => edit.keyPath === 'projects').flatMap((edit) => Object.keys(edit.value));
    mkdirSync(codexHome, { recursive: true });
    appendFileSync(join(codexHome, 'config.toml'), folders.map((folder) => `\n[projects.${JSON.stringify(folder)}]\ntrust_level = "trusted"\n`).join(''));
  }
  return {};
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const request = requestSchema.safeParse(JSON.parse(line));
  if (request.success && request.data.id !== undefined) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.data.id, result: answerOf(request.data.method, request.data.params) })}\n`);
  }
});
