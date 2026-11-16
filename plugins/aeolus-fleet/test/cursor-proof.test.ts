/** Captured Cursor CLI evidence for the CC1 gate, without claiming unsupported roles. */
import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/cursor/2026.11.13-eacade1/linux/${name}`, import.meta.url), 'utf8');
const hooks = () => fixture('hooks.jsonl').trim().split('\n').map((line) => z.object({ event: z.string(), input: z.record(z.string(), z.unknown()), output: z.record(z.string(), z.unknown()) }).parse(JSON.parse(line)));
const events = () => fixture('first.events.jsonl').trim().split('\n').map((line) => z.object({ type: z.string(), result: z.string().optional(), is_error: z.boolean().optional() }).parse(JSON.parse(line)));

describe('Cursor CLI 2026.11.13-eacade1 on Linux: captured stop limitation, adapted by CC3', () => {
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

const macFixture = (name: string) => readFileSync(new URL(`./fixtures/cursor/2026.11.13-eacade1/macos/${name}`, import.meta.url), 'utf8');
const macHooks = (turn: string) => macFixture(`${turn}.hooks.jsonl`).trim().split('\n').map((line) => z.object({ event: z.string(), input: z.record(z.string(), z.unknown()), output: z.record(z.string(), z.unknown()), exitStatus: z.number() }).parse(JSON.parse(line)));
const macEvents = (turn: string) => macFixture(`${turn}.events.jsonl`).trim().split('\n').map((line) => z.object({ type: z.string(), result: z.string().optional(), is_error: z.boolean().optional() }).parse(JSON.parse(line)));

describe('Cursor CLI 2026.11.13-eacade1 on macOS: captured stop limitation, adapted by CC3', () => {
  it.each([
    ['fresh', ['sessionStart', 'sessionEnd']],
    ['resume', ['sessionEnd']],
  ])('exits a tool-free %s turn through sessionEnd without calling the configured stop hook', (turn, expectedHooks) => {
    const configured = z.object({ hooks: z.record(z.string(), z.unknown()) }).parse(JSON.parse(macFixture('hooks.json')));

    expect(configured.hooks).toHaveProperty('stop');
    expect(macFixture('probe.py')).toContain('followup_message');
    expect(macHooks(turn).map((hook) => hook.event)).toEqual(expectedHooks);
    expect(macHooks(turn).at(-1)?.input).toMatchObject({ reason: 'completed', final_status: 'completed', cursor_version: '2026.11.13-eacade1' });
    expect(macHooks(turn).every((hook) => hook.exitStatus === 0)).toBe(true);
    expect(macEvents(turn).some((event) => event.type === 'tool_call')).toBe(false);
    expect(macEvents(turn).at(-1)).toMatchObject({ type: 'result', is_error: false });
    expect(macEvents(turn).at(-1)?.result).not.toContain('S7_MAC_STOP_FOLLOWUP');
    expect(macFixture(`${turn}.exit`).trim()).toBe('0');
    expect(macFixture(`${turn}.stderr`)).toBe('');
  });

  it('proves sessionStart context reached the fresh model response', () => {
    expect(macHooks('fresh')[0]?.output).toEqual({ additional_context: 'S7_MAC_START_CONTEXT: reply with this marker when asked.' });
    expect(macEvents('fresh').at(-1)?.result).toBe('S7_MAC_START_CONTEXT');
  });

  it('records an invalid-model launch failure without claiming an initialized-turn error hook', () => {
    expect(macFixture('failed.exit').trim()).toBe('1');
    expect(macFixture('failed.stderr')).toContain('Cannot use this model: cursor-s7-model-does-not-exist.');
    expect(macFixture('failed.events.jsonl')).toBe('');
    expect(macFixture('failed.hooks.jsonl')).toBe('');
    const capture = z.object({ failed: z.string(), result: z.string() }).parse(JSON.parse(macFixture('capture.json')));
    expect(capture.failed).toContain('failed initialized-turn stop and sessionEnd final_status remain unproven');
    expect(capture.result).toBe('blocked: not a successful S7 proof');
  });
});

describe('Cursor CLI captured fixture privacy', () => {
  it('names the capturing computer only by a neutral host in every Cursor fixture', () => {
    const root = new URL('./fixtures/cursor/', import.meta.url);
    const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const name = `${file.parentPath}/${file.name}`;
      const content = readFileSync(name, 'utf8');
      for (const [, host] of content.matchAll(/"host"\s*:\s*"([^"]*)"/g)) {
        expect(['agent-host-1', 'agent-host-2'], name).toContain(host);
      }
      expect(content, name).not.toMatch(/mac[ -]?mini|macbook|\bimac\b|[\w-]+\.local\b(?!\/)/i);
    }
  });
});
