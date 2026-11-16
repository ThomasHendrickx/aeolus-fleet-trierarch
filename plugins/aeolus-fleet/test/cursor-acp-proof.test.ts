/** ACP evidence comes from real CLI processes, never model self-reports. */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const record = z.object({
  process: z.string(),
  direction: z.enum(['sent', 'received']),
  message: z.object({
    id: z.number().optional(),
    method: z.string().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    result: z.record(z.string(), z.unknown()).optional(),
  }),
});
const capture = () => readFileSync(new URL('./fixtures/cursor-acp/2026.11.13-eacade1/linux/model-isolation.jsonl', import.meta.url), 'utf8')
  .trim().split('\n').map((line) => record.parse(JSON.parse(line)));
const modelOption = z.object({ configOptions: z.array(z.object({ id: z.string(), currentValue: z.string() })) });

 describe('Cursor ACP Linux: model isolation across live processes', () => {
  it('keeps the second live process on its model after changing the first process model', () => {
    const messages = capture();
    const state = (process: string, id: number) => modelOption.parse(messages.find((entry) => entry.process === process && entry.direction === 'received' && entry.message.id === id)?.message.result)
      .configOptions.find((option) => option.id === 'model')?.currentValue;

    expect(state('B', 4)).toBe('gpt-5.4-mini[reasoning=medium]');
    expect(state('A', 6)).toBe('composer-2.5[fast=true]');
    expect(state('B', 6)).toBe('gpt-5.4-mini[reasoning=medium]');
    expect(messages.some((entry) => entry.process === 'A' && entry.message.method === 'session/set_model')).toBe(true);
  });
});
