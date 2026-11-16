/** Captured ACP wire evidence on the supported macOS Cursor build. */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/cursor-acp/2026.11.13-eacade1/macos/${name}`, import.meta.url), 'utf8');
const messageSchema = z.object({
  direction: z.enum(['sent', 'received', 'observation']),
  process: z.string(),
  elapsedMs: z.number().nonnegative(),
  message: z.record(z.string(), z.unknown()),
});
const trace = (name: string) => fixture(`${name}.jsonl`).trim().split('\n').map((line) => messageSchema.parse(JSON.parse(line)));

describe('Cursor CLI 2026.11.13-eacade1 ACP on macOS', () => {
  it('captures the protocol capabilities and machine login method', () => {
    expect(trace('lifecycle')).toContainEqual(expect.objectContaining({ direction: 'received', message: expect.objectContaining({ result: expect.objectContaining({ protocolVersion: 1, agentCapabilities: expect.objectContaining({ loadSession: true }), authMethods: expect.arrayContaining([expect.objectContaining({ id: 'cursor_login' })]) }) }) }));
  });

  it('observes live model isolation through protocol configuration, without asking the model its identity', () => {
    const observations = trace('model-isolation').filter((entry) => entry.direction === 'observation').map((entry) => entry.message);
    expect(observations).toContainEqual(expect.objectContaining({ event: 'live-model-isolation', status: 'proven', before: 'gpt-5.4-mini[reasoning=medium]', after: 'gpt-5.4-mini[reasoning=medium]' }));
  });

  it('keeps a permission request open for at least thirty minutes before answering it', () => {
    const entries = trace('permission-hold');
    const requested = entries.find((entry) => entry.direction === 'received' && entry.message.method === 'session/request_permission');
    const answered = entries.find((entry) => entry.direction === 'sent' && entry.message.result !== undefined);
    expect(requested).toBeDefined();
    expect(answered).toBeDefined();
    expect((answered?.elapsedMs ?? 0) - (requested?.elapsedMs ?? 0)).toBeGreaterThanOrEqual(1_800_000);
    expect(entries).toContainEqual(expect.objectContaining({ direction: 'received', message: expect.objectContaining({ result: { stopReason: 'end_turn' } }) }));
  });

  it('keeps personal paths and credentials out of every captured trace', () => {
    for (const name of ['lifecycle', 'model-isolation', 'permission-hold', 'configuration']) {
      const content = fixture(`${name}.jsonl`);
      expect(content).not.toMatch(/\/Users\/[^/\s"']+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|Bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]{12,}/i);
      expect(trace(name).length).toBeGreaterThan(0);
    }
  });
});
