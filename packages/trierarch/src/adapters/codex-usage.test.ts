import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../../test/support/in-memory.js';
import { createCodexUsage } from './codex-usage.js';

// On a session log (rollout file) of a real Codex session, kept to its session start, turns and token counts, every text elided (#353).
// Codex documents no format for them: when a recapture on a newer Codex fails here, its format changed, and the reader must follow it.

const FOLDER = '/home/operator/ship';
const DAY = join('2026', '10', '15');
const ROLLOUT = 'rollout-2026-10-15T19-04-09-01a14085-6f83-7763-ab56-8681c4557c43.jsonl';

let sessions: string;

beforeEach(async () => {
  sessions = await mkdtemp(join(tmpdir(), 'aeolus-codex-sessions-'));
  await mkdir(join(sessions, DAY), { recursive: true });
});

afterEach(async () => {
  await rm(sessions, { recursive: true, force: true });
});

const captured = (): Promise<string> => readFile(new URL('../../test/logs/codex-tokens.jsonl', import.meta.url), 'utf8');

function aUsage(madeAt = '2026-10-15T00:00:00.000Z') {
  return createCodexUsage({ sessions, madeAt: () => Promise.resolve(new Date(madeAt)) });
}

/** A rollout of its own, in another folder or started at another time, from the captured one. */
async function withRollout(name: string, edit: (log: string) => string): Promise<void> {
  await writeFile(join(sessions, DAY, name), edit(await captured()));
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

const SOL = { model: 'gpt-6.1-sol', tokens: { input: 43_216, output: 1428, cacheRead: 250_240, cacheWrite: 0 } };

describe("a Codex ship's tokens, from its session logs (#353)", () => {
  it("sums the tokens of each model its folder's sessions used, input without what was read from the cache", async () => {
    await copyFile(new URL('../../test/logs/codex-tokens.jsonl', import.meta.url), join(sessions, DAY, ROLLOUT));

    expect(perModel(await aUsage().tokensOf({ shipId: newId('ship'), folder: FOLDER }))).toEqual([SOL]);
  });

  it("leaves out the sessions of another folder, and those started before the ship's folder was made", async () => {
    await withRollout('rollout-other.jsonl', (log) => log.replace(`"cwd":"${FOLDER}"`, '"cwd":"/home/operator/other"'));

    const before = aUsage('2026-10-15T18:00:00.000Z');
    await copyFile(new URL('../../test/logs/codex-tokens.jsonl', import.meta.url), join(sessions, DAY, ROLLOUT));

    expect(perModel(await before.tokensOf({ shipId: newId('ship'), folder: FOLDER }))).toEqual([]);
  });

  it('gives each turn its tokens to the model of that turn', async () => {
    const turn = (model: string) => JSON.stringify({ timestamp: '2026-10-15T17:10:00.000Z', type: 'turn_context', payload: { model } });
    const counted = (total: number) =>
      JSON.stringify({ timestamp: '2026-10-15T17:10:01.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 } } } });
    const meta = JSON.stringify({ timestamp: '2026-10-15T17:09:00.000Z', type: 'session_meta', payload: { timestamp: '2026-10-15T17:09:00.000Z', cwd: FOLDER } });
    await writeFile(join(sessions, DAY, 'rollout-switch.jsonl'), [meta, turn('gpt-6.1-sol'), counted(100), turn('gpt-6-luna'), counted(130), counted(130), ''].join('\n'));

    expect(perModel(await aUsage().tokensOf({ shipId: newId('ship'), folder: FOLDER }))).toEqual([
      { model: 'gpt-6-luna', tokens: { input: 30, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { model: 'gpt-6.1-sol', tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ]);
  });
});

describe("a Codex ship's tokens per UTC hour (the usage design)", () => {
  it('counts each turn in the UTC hour its token count was written', async () => {
    const meta = JSON.stringify({ timestamp: '2026-10-15T17:09:00.000Z', type: 'session_meta', payload: { timestamp: '2026-10-15T17:09:00.000Z', cwd: FOLDER } });
    const turn = JSON.stringify({ timestamp: '2026-10-15T17:10:00.000Z', type: 'turn_context', payload: { model: 'gpt-6.1-sol' } });
    const counted = (total: number, at: string) =>
      JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 } } } });
    await writeFile(join(sessions, DAY, 'rollout-hours.jsonl'), [meta, turn, counted(100, '2026-10-15T17:59:59.000Z'), counted(130, '2026-10-15T18:00:00.000Z'), ''].join('\n'));

    expect(await aUsage().tokensOf({ shipId: newId('ship'), folder: FOLDER })).toEqual([
      { model: 'gpt-6.1-sol', hour: new Date('2026-10-15T17:00:00.000Z'), tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { model: 'gpt-6.1-sol', hour: new Date('2026-10-15T18:00:00.000Z'), tokens: { input: 30, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ]);
  });
});

describe("a Codex ship's tokens per login (api keys K8)", () => {
  it('counts each token count to the login of the session that wrote it, when it is told the logins its sessions ran on', async () => {
    const meta = JSON.stringify({ timestamp: '2026-10-15T17:09:00.000Z', type: 'session_meta', payload: { timestamp: '2026-10-15T17:09:00.000Z', cwd: FOLDER } });
    const turn = JSON.stringify({ timestamp: '2026-10-15T17:10:00.000Z', type: 'turn_context', payload: { model: 'gpt-6.1-sol' } });
    const counted = (total: number, at: string) =>
      JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 } } } });
    await writeFile(join(sessions, DAY, 'rollout-resumed.jsonl'), [meta, turn, counted(100, '2026-10-15T17:10:01.000Z'), counted(130, '2026-10-15T17:20:01.000Z'), ''].join('\n'));
    const logins = { login: 'apiKey' as const, earlierLogins: [{ login: 'subscription' as const, until: '2026-10-15T17:15:00.000Z' }] };

    expect(perModel(await aUsage().tokensOf({ shipId: newId('ship'), folder: FOLDER, logins }))).toEqual([
      { model: 'gpt-6.1-sol', login: 'apiKey', tokens: { input: 30, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { model: 'gpt-6.1-sol', login: 'subscription', tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ]);
  });
});

describe("Codex's subscription, from its newest session log (#353)", () => {
  it('reads how much of its windows the last token count says is used, and when each starts again', async () => {
    await withRollout('rollout-2026-10-14T08-00-00-old.jsonl', (log) => log.replaceAll('"used_percent":2.0', '"used_percent":99.0'));
    await copyFile(new URL('../../test/logs/codex-tokens.jsonl', import.meta.url), join(sessions, DAY, ROLLOUT));

    expect(await aUsage().subscription()).toEqual([
      { windowMinutes: 300, usedPercent: 2, resetsAt: new Date('2026-10-15T22:04:13.000Z') },
      { windowMinutes: 10_080, usedPercent: 0, resetsAt: new Date('2026-10-22T17:04:13.000Z') },
    ]);
  });

  it('says nothing before Codex wrote any session log', async () => {
    expect(await aUsage().subscription()).toBeUndefined();
  });
});
