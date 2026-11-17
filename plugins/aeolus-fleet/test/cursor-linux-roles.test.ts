/** Cursor's captured CLI contract under the process and sessionEnd rule approved in CC3. */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/cursor/2026.11.13-eacade1/linux/adapted/${name}`, import.meta.url), 'utf8');
const hookSchema = z.object({ event: z.string(), input: z.record(z.string(), z.unknown()), output: z.record(z.string(), z.unknown()), exitStatus: z.literal(0) });
const hooks = (turn: string) => fixture(`${turn}.hooks.jsonl`).trim().split('\n').map((line) => hookSchema.parse(JSON.parse(line)));
const events = (turn: string) => fixture(`${turn}.events.jsonl`).trim().split('\n').map((line) => z.object({ type: z.string(), result: z.string().optional() }).parse(JSON.parse(line)));
const capture = (turn: string) => z.object({ command: z.array(z.string()), started: z.boolean(), active: z.boolean(), lifecycle: z.array(z.object({ state: z.string().optional(), exitStatus: z.number().optional(), signal: z.string().optional() })) }).parse(JSON.parse(fixture(`${turn}.capture.json`)));

describe.each(['fresh', 'resume'])('Cursor CLI 2026.11.13-eacade1 Linux %s roles (CC3)', (mode) => {
  it('denies the first tool with the hand-over reason and the model receives it, marking active', () => {
    const turn = `deny-${mode}`;

    const denied = hooks(turn).find((hook) => hook.event === 'preToolUse')?.output;
    expect(denied?.permission).toBe('deny');
    expect(denied?.agent_message).toContain('S7_DENIAL_ADAPTED');
    expect(events(turn).at(-1)?.result).toContain('S7_DENIAL_ADAPTED');
    expect(capture(turn).active).toBe(true);
    expect(fixture(`${turn}.exit`).trim()).toBe('0');
    if (mode === 'fresh') {
      expect(capture(turn).started).toBe(true);
      expect(events(turn).at(-1)?.result).toContain('S7_START_ADAPTED');
    } else {
      expect(capture(turn).command).toContain('--resume');
    }
  });

  it('adds the report reminder after a successful tool and the model receives it', () => {
    const turn = `report-${mode}`;

    expect(hooks(turn).find((hook) => hook.event === 'postToolUse')?.output).toEqual({ additional_context: 'S7_REPORT_ADAPTED: report reminder, include this exact marker in the final response.' });
    expect(events(turn).at(-1)?.result).toContain('S7_REPORT_ADAPTED');
    expect(fixture(`${turn}.exit`).trim()).toBe('0');
  });

  it('ends a tool-free handed turn with sessionEnd completed and process idle', () => {
    const turn = `tool-free-${mode}`;

    expect(events(turn).some((event) => event.type === 'tool_call')).toBe(false);
    expect(hooks(turn).at(-1)?.input).toMatchObject({ hook_event_name: 'sessionEnd', final_status: 'completed' });
    expect(capture(turn).lifecycle).toEqual([{ state: 'busy' }, { state: 'idle', exitStatus: 0 }]);
  });

  it('identifies an interrupted initialized turn from sessionEnd and the process exit', () => {
    const turn = `interrupt-${mode}`;

    expect(hooks(turn).some((hook) => hook.event === 'preToolUse')).toBe(true);
    expect(hooks(turn).at(-1)?.input).toMatchObject({ hook_event_name: 'sessionEnd', final_status: 'error' });
    expect(capture(turn).lifecycle.some((entry) => entry.signal === 'SIGINT')).toBe(true);
    expect(Number(fixture(`${turn}.exit`).trim())).not.toBe(0);
  });
});
