/** Captured macOS proof of Cursor's process and sessionEnd delivery roles. */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/cursor/2026.11.13-eacade1/macos/adapted/${name}`, import.meta.url), 'utf8');
const hookSchema = z.object({
  event: z.string(),
  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()),
  markers: z.array(z.string()),
  exitStatus: z.number(),
});
const eventSchema = z.object({ type: z.string(), result: z.string().optional(), is_error: z.boolean().optional() });
const hooks = (turn: string) => fixture(`${turn}.hooks.jsonl`).trim().split('\n').map((line) => hookSchema.parse(JSON.parse(line)));
const events = (turn: string) => fixture(`${turn}.events.jsonl`).trim().split('\n').map((line) => eventSchema.parse(JSON.parse(line)));
const processSchema = z.array(z.object({ event: z.string(), turn: z.string().optional(), exitStatus: z.number().optional(), signal: z.string().optional(), after: z.string().optional(), target: z.string().optional() }));
const processSteps = (turn: string) => processSchema.parse(JSON.parse(fixture(`${turn}.process.json`)));

for (const mode of ['fresh', 'resume']) {
  describe(`Cursor CLI 2026.11.13-eacade1 on macOS: adapted ${mode} turn roles`, () => {
    it('denies the first tool call with the hand-over received by the model and marks the launch active', () => {
      const turn = `deny-${mode}`;
      const marker = `S7_MAC_DENIAL_${mode.toUpperCase()}`;
      const denied = hooks(turn).find((hook) => hook.event === 'preToolUse');

      expect(denied?.output).toMatchObject({ permission: 'deny', agent_message: `${marker}: Tool denied for a hand-over. Include this exact marker in your final answer.` });
      expect(denied?.markers).toEqual(['active', 'hand-over-confirmed']);
      expect(hooks(turn).find((hook) => hook.event === 'postToolUseFailure')?.input).toMatchObject({ failure_type: 'permission_denied' });
      expect(events(turn).at(-1)?.result).toContain(marker);
      expect(fixture(`${turn}.exit`).trim()).toBe('0');
    });

    it('adds a postToolUse report reminder that reaches the model after an executed tool', () => {
      const turn = `report-${mode}`;
      const marker = `S7_MAC_REPORT_REMINDER_${mode.toUpperCase()}`;
      const report = hooks(turn).find((hook) => hook.event === 'postToolUse');

      expect(report?.output).toEqual({ additional_context: `${marker}: Include this exact report reminder marker in your final answer.` });
      const toolOutput = z.object({ output: z.string(), exitCode: z.number() }).parse(JSON.parse(z.string().parse(report?.input.tool_output)));
      expect(toolOutput.exitCode).toBe(0);
      expect(toolOutput.output).toContain(mode === 'fresh' ? 'S7_MAC_ALLOWED_TOOL' : 'S7_MAC_ALLOWED_RESUME');
      expect(events(turn).at(-1)?.result).toContain(marker);
      expect(fixture(`${turn}.exit`).trim()).toBe('0');
    });

    it('confirms a tool-free hand-over at sessionEnd with final_status completed', () => {
      const turn = `tool-free-${mode}`;
      const ended = hooks(turn).at(-1);

      expect(events(turn).some((event) => event.type === 'tool_call')).toBe(false);
      expect(ended).toMatchObject({ event: 'sessionEnd', input: { reason: 'completed', final_status: 'completed' }, markers: ['hand-over-confirmed'], exitStatus: 0 });
      expect(events(turn).at(-1)).toMatchObject({ type: 'result', is_error: false });
      expect(fixture(`${turn}.exit`).trim()).toBe('0');
    });

    it('identifies a died initialized turn from sessionEnd final_status error and exit 130 after SIGINT', () => {
      const turn = `interrupted-${mode}`;

      expect(events(turn).some((event) => event.type === 'system')).toBe(true);
      expect(hooks(turn).some((hook) => hook.event === 'preToolUse')).toBe(true);
      expect(processSteps(turn)).toContainEqual({ event: 'signal', signal: 'SIGINT', after: 'preToolUse', target: 'owned agent PID' });
      expect(hooks(turn).at(-1)).toMatchObject({ event: 'sessionEnd', input: { reason: 'error', final_status: 'error' }, markers: [], exitStatus: 0 });
      expect(fixture(`${turn}.exit`).trim()).toBe('130');
    });

    it.each(['deny', 'report', 'tool-free', 'interrupted'])('marks the %s process busy at start and idle at exit', (role) => {
      const turn = `${role}-${mode}`;
      const steps = processSteps(turn);
      const expectedExit = role === 'interrupted' ? 130 : 0;

      expect(steps[0]).toEqual({ event: 'process-start', turn: 'busy' });
      expect(steps.at(-1)).toEqual({ event: 'process-exit', turn: 'idle', exitStatus: expectedExit });
      expect(hooks(turn).every((hook) => hook.exitStatus === 0)).toBe(true);
      if (mode === 'fresh') {
        expect(hooks(turn)[0]).toMatchObject({ event: 'sessionStart', markers: ['started'] });
      }
    });
  });
}
