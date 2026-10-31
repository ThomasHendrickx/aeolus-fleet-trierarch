import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../../test/support/in-memory.js';
import { createClaudeCodeUsage } from './claude-code-usage.js';
import type { CommandResult } from './run-command.js';

// On transcripts of Claude Code 2.1.29x and a print-mode turn of 2.1.306, captured from real sessions, every text elided (#353).
// Claude Code documents no format for them: when a recapture on a newer Claude Code fails here, its format changed, and the reader must follow it.

const logUrl = (name: string): URL => new URL(`../../test/logs/${name}`, import.meta.url);

const FOLDER = '/home/thomas/.aeolus/trierarch/worktrees/aeolus-fleet/scout';
/** Claude Code's name for the folder's conversations: every character other than a letter or digit as a dash. */
const PROJECT = '-home-thomas--aeolus-trierarch-worktrees-aeolus-fleet-scout';

let projects: string;

beforeEach(async () => {
  projects = await mkdtemp(join(tmpdir(), 'aeolus-claude-projects-'));
});

afterEach(async () => {
  await rm(projects, { recursive: true, force: true });
});

/** The ship's folder has the captured conversation, and a sub-agent of it the captured sub-agent's. */
async function withConversations(): Promise<void> {
  await mkdir(join(projects, PROJECT, 'e5346dbb', 'subagents'), { recursive: true });
  await copyFile(logUrl('claude-code-session.jsonl'), join(projects, PROJECT, 'e5346dbb.jsonl'));
  await copyFile(logUrl('claude-code-subagent.jsonl'), join(projects, PROJECT, 'e5346dbb', 'subagents', 'agent-a7aea085efb2f4eff.jsonl'));
}

function aUsage(at: { madeAt?: string; probe?: CommandResult } = {}) {
  return createClaudeCodeUsage({
    projectsOf: () => projects,
    madeAt: () => Promise.resolve(new Date(at.madeAt ?? '2026-10-09T00:00:00.000Z')),
    run: () => Promise.resolve(at.probe ?? { status: 1, stdout: '', stderr: 'not logged in' }),
    neutralFolder: () => Promise.resolve(projects),
  });
}

/** What the reader counted, added up per model and login over the hours, as the report gives it. */
function perModel(counted: readonly { model: string; login?: string; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } }[]) {
  const summed = new Map<string, { model: string; login?: string; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } }>();
  for (const { model, login, tokens } of counted) {
    const key = `${model} ${login ?? ''}`;
    const before = summed.get(key)?.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    summed.set(key, { model, ...(login !== undefined && { login }), tokens: { input: before.input + tokens.input, output: before.output + tokens.output, cacheRead: before.cacheRead + tokens.cacheRead, cacheWrite: before.cacheWrite + tokens.cacheWrite } });
  }
  return [...summed.values()];
}

const OPUS = { model: 'claude-opus-5-5', tokens: { input: 16, output: 1687, cacheRead: 326_051, cacheWrite: 68_515 } };
const SONNET = { model: 'claude-sonnet-5-5', tokens: { input: 8, output: 988, cacheRead: 143_335, cacheWrite: 52_804 } };

describe("a Claude Code ship's tokens, from its transcripts (#353)", () => {
  it('sums each model its conversations and their sub-agents used, each message once however many lines it spans', async () => {
    await withConversations();

    expect(perModel(await aUsage().tokensOf({ shipId: newId('ship'), folder: FOLDER }))).toEqual([OPUS, SONNET]);
  });

  it('counts only what was used since the folder was made, so a ship of the same name before counts nothing', async () => {
    await withConversations();

    const usage = aUsage({ madeAt: '2026-10-09T16:00:00.000Z' });

    expect(perModel(await usage.tokensOf({ shipId: newId('ship'), folder: FOLDER }))).toEqual([{ model: 'claude-opus-5-5', tokens: { input: 4, output: 400, cacheRead: 25_945, cacheWrite: 34_622 } }, SONNET]);
  });

  it('counts each message to the login of the session that wrote it, when it is told the logins its sessions ran on (api keys K8)', async () => {
    await withConversations();

    const logins = { login: 'apiKey' as const, earlierLogins: [{ login: 'subscription' as const, until: '2026-10-09T16:00:00.000Z' }] };

    expect(perModel(await aUsage().tokensOf({ shipId: newId('ship'), folder: FOLDER, logins }))).toEqual([
      { model: 'claude-opus-5-5', login: 'apiKey', tokens: { input: 4, output: 400, cacheRead: 25_945, cacheWrite: 34_622 } },
      { model: 'claude-opus-5-5', login: 'subscription', tokens: { input: 12, output: 1287, cacheRead: 300_106, cacheWrite: 33_893 } },
      { ...SONNET, login: 'apiKey' },
    ]);
  });

  it('adds what a conversation wrote since the last read, and a line only once it is written whole', async () => {
    await withConversations();
    const usage = aUsage();
    const shipId = newId('ship');
    await usage.tokensOf({ shipId, folder: FOLDER });
    const line = JSON.stringify({ type: 'assistant', timestamp: '2026-10-10T08:00:00.000Z', message: { id: 'msg_new', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } } });
    const transcript = join(projects, PROJECT, 'e5346dbb.jsonl');

    await appendFile(transcript, line.slice(0, 40));
    const half = await usage.tokensOf({ shipId, folder: FOLDER });
    await appendFile(transcript, `${line.slice(40)}\n`);
    const whole = await usage.tokensOf({ shipId, folder: FOLDER });

    expect([perModel(half)[0], perModel(whole)[0]]).toEqual([OPUS, { model: 'claude-opus-5-5', tokens: { input: 17, output: 1689, cacheRead: 326_054, cacheWrite: 68_519 } }]);
  });

  it('counts each message in the UTC hour its transcript says it was written', async () => {
    await withConversations();

    expect(await aUsage().tokensOf({ shipId: newId('ship'), folder: FOLDER })).toEqual([
      { model: 'claude-opus-5-5', hour: new Date('2026-10-09T15:00:00.000Z'), tokens: { input: 12, output: 1287, cacheRead: 300_106, cacheWrite: 33_893 } },
      { model: 'claude-opus-5-5', hour: new Date('2026-10-09T17:00:00.000Z'), tokens: { input: 4, output: 400, cacheRead: 25_945, cacheWrite: 34_622 } },
      { ...SONNET, hour: new Date('2026-10-22T12:00:00.000Z') },
    ]);
  });

  it('answers no tokens for a folder Claude Code has no conversation of', async () => {
    expect(perModel(await aUsage().tokensOf({ shipId: newId('ship'), folder: FOLDER }))).toEqual([]);
  });
});

describe("Claude Code's subscription, from a print-mode turn (#353)", () => {
  it('reads how much of its 5 hour and 7 day windows is used, and when each starts again', async () => {
    const stdout = await readFile(logUrl('claude-code-usage-probe.jsonl'), 'utf8');

    expect(await aUsage({ probe: { status: 0, stdout, stderr: '' } }).subscription()).toEqual([
      { windowMinutes: 300, usedPercent: 9, resetsAt: new Date('2026-10-25T01:20:00.000Z') },
      { windowMinutes: 10_080, usedPercent: 70, resetsAt: new Date('2026-10-28T00:00:00.000Z') },
    ]);
  });

  it('says nothing when the turn says nothing of its windows, as when it is not logged in', async () => {
    expect(await aUsage().subscription()).toBeUndefined();
  });
});
