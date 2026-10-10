import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createCodexSetup } from './codex-setup.js';

// Against a stand-in for `codex app-server`: JSON-RPC over stdio, one message a line, as Codex speaks it.

let folder: string;
let log: string;
let program: string;

const requestSchema = z.object({ method: z.string(), params: z.unknown().optional() });

const HOOKS = [
  { key: 'aeolus@aeolus-fleet:hooks/hooks.json:stop:0:0', pluginId: 'aeolus@aeolus-fleet', currentHash: 'sha256:changed', trustStatus: 'modified' },
  { key: 'aeolus@aeolus-fleet:hooks/hooks.json:user_prompt_submit:0:0', pluginId: 'aeolus@aeolus-fleet', currentHash: 'sha256:new', trustStatus: 'untrusted' },
  { key: 'aeolus@aeolus-fleet:hooks/hooks.json:session_start:0:0', pluginId: 'aeolus@aeolus-fleet', currentHash: 'sha256:same', trustStatus: 'trusted' },
  { key: 'other@elsewhere:hooks/hooks.json:stop:0:0', pluginId: 'other@elsewhere', currentHash: 'sha256:other', trustStatus: 'untrusted' },
];

/** A stand-in app server: logs every message it gets, answers each request; `failing` names a method it answers with an error. */
function anAppServer(failing = '') {
  writeFileSync(
    program,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const readline = require('node:readline');
if (process.argv[2] !== 'app-server') process.exit(2);
const hooks = ${JSON.stringify(HOOKS)};
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  appendFileSync(${JSON.stringify(log)}, line + '\\n');
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const answer = (result) => process.stdout.write(JSON.stringify({ id: message.id, ...result }) + '\\n');
  if (message.method === ${JSON.stringify(failing)}) return answer({ error: { code: -32600, message: 'no such thing' } });
  if (message.method === 'initialize') return answer({ result: {} });
  if (message.method === 'hooks/list') return answer({ result: { data: message.params.cwds.map((cwd) => ({ cwd, hooks, warnings: [], errors: [] })) } });
  if (message.method === 'config/batchWrite') return answer({ result: { status: 'ok' } });
  answer({ error: { code: -32601, message: 'unknown method' } });
});
`,
  );
  chmodSync(program, 0o700);
  return createCodexSetup({ command: program });
}

/** The requests the stand-in got, by method. */
function requests(method: string): unknown[] {
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => requestSchema.parse(JSON.parse(line)))
    .filter((request) => request.method === method)
    .map((request) => request.params);
}

/** A stand-in app server that answers `initialize`, then stops reading and ends: what it is sent next has no reader. */
function anAppServerThatEndsEarly() {
  writeFileSync(
    program,
    `#!/usr/bin/env node
const { closeSync } = require('node:fs');
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).once('line', (line) => {
  closeSync(0);
  process.stdout.write(JSON.stringify({ id: JSON.parse(line).id, result: {} }) + '\\n', () => process.exit(0));
});
`,
  );
  chmodSync(program, 0o700);
  return createCodexSetup({ command: program });
}

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'trierarch-codex-setup-'));
  log = join(folder, 'requests.log');
  program = join(folder, 'codex');
  writeFileSync(log, '');
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe("Codex's one-time questions, answered ahead through its app server", () => {
  it('trusts each folder in Codex\'s own configuration, as its trust dialog does', async () => {
    await anAppServer().trust(['/home/thomas/Projects/aeolus-fleet', '/home/thomas/notes']);

    expect(requests('config/batchWrite')).toEqual([
      {
        edits: [{ keyPath: 'projects', value: { '/home/thomas/Projects/aeolus-fleet': { trust_level: 'trusted' }, '/home/thomas/notes': { trust_level: 'trusted' } }, mergeStrategy: 'upsert' }],
        reloadUserConfig: true,
      },
    ]);
  });

  it("trusts the aeolus plugin's hooks that are new or changed, with the hash Codex gives them, and no other plugin's", async () => {
    const trusted = await anAppServer().trustAeolusHooks('/home/thomas/.aeolus/trierarch/worktrees');

    expect(trusted).toEqual(['aeolus@aeolus-fleet:hooks/hooks.json:stop:0:0', 'aeolus@aeolus-fleet:hooks/hooks.json:user_prompt_submit:0:0']);
    expect(requests('hooks/list')).toEqual([{ cwds: ['/home/thomas/.aeolus/trierarch/worktrees'] }]);
    expect(requests('config/batchWrite')).toEqual([
      {
        edits: [
          {
            keyPath: 'hooks.state',
            value: { 'aeolus@aeolus-fleet:hooks/hooks.json:stop:0:0': { trusted_hash: 'sha256:changed' }, 'aeolus@aeolus-fleet:hooks/hooks.json:user_prompt_submit:0:0': { trusted_hash: 'sha256:new' } },
            mergeStrategy: 'upsert',
          },
        ],
        reloadUserConfig: true,
      },
    ]);
  });

  it('introduces itself before any request, as an app server client must', async () => {
    await anAppServer().trust(['/home/thomas/notes']);

    expect(readFileSync(log, 'utf8').split('\n')[0]).toContain('"method":"initialize"');
    expect(requests('initialized')).toHaveLength(1);
  });

  it('fails with what the app server answered when it refuses a request', async () => {
    await expect(anAppServer('config/batchWrite').trust(['/home/thomas/notes'])).rejects.toThrow('config/batchWrite: no such thing');
  });

  it('fails saying Codex is missing when there is no codex to run', async () => {
    await expect(createCodexSetup({ command: join(folder, 'no-codex') }).trust(['/home/thomas/notes'])).rejects.toThrow('Codex');
  });

  it('fails, rather than ending the trierarch, when the app server ends before it reads what it is sent', async () => {
    await expect(anAppServerThatEndsEarly().trust(['/home/thomas/notes'])).rejects.toThrow('codex app-server');
  });
});
