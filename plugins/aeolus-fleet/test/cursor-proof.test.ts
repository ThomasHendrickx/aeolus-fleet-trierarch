/** Captured Cursor CLI evidence for the CC1 gate, without claiming unsupported roles. */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/cursor/2026.11.13-eacade1/linux/${name}`, import.meta.url), 'utf8');
const hooks = () => fixture('hooks.jsonl').trim().split('\n').map((line) => z.object({ event: z.string(), input: z.record(z.string(), z.unknown()), output: z.record(z.string(), z.unknown()) }).parse(JSON.parse(line)));
const events = () => fixture('first.events.jsonl').trim().split('\n').map((line) => z.object({ type: z.string(), result: z.string().optional(), is_error: z.boolean().optional() }).parse(JSON.parse(line)));

describe('Cursor CLI 2026.11.13-eacade1 on Linux: CC1 stops at the missing stop role', () => {
  it('registers stop but exits successfully through sessionEnd without calling it', () => {
    const configured = z.object({ hooks: z.record(z.string(), z.unknown()) }).parse(JSON.parse(fixture('hooks.json')));

    expect(configured.hooks).toHaveProperty('stop');
    expect(hooks().map((hook) => hook.event)).toEqual(['sessionStart', 'preToolUse', 'postToolUseFailure', 'sessionEnd']);
    expect(hooks().at(-1)?.input).toMatchObject({ reason: 'completed', final_status: 'completed', cursor_version: '2026.11.13-eacade1' });
    expect(events().at(-1)).toMatchObject({ type: 'result', is_error: false });
    expect(fixture('first.exit').trim()).toBe('0');
    expect(fixture('first.stderr')).toBe('');
  });

  it('proves start context and the denied hand-over reached the model, while the stop follow-up did not', () => {
    const answer = events().at(-1)?.result;

    expect(answer).toContain('S7_START_CONTEXT_73');
    expect(answer).toContain('S7_DENIAL_83');
    expect(answer).not.toContain('S7_FOLLOWUP_43');
    expect(hooks().find((hook) => hook.event === 'preToolUse')?.output).toMatchObject({ permission: 'deny' });
  });
});
