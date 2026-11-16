import { z } from 'zod';

import type { AdapterFlag } from '../core/ports.js';
import { partsWithWords, type CommandPart } from './command-line.js';
import { parsedLine } from './hold-protocol.js';
import type { EventActivity } from './session-activity.js';

/** Cursor CLI's captured turn-per-process protocol (CC4): trusted stream-json, a positional prompt after --, and explicit chat resume. */
const OUTPUT = '--output-format=stream-json';
const TRUST = '--trust';
const PRINT = '--print';
const RESUME = '--resume=';

export const CURSOR_ADAPTER_FLAGS: readonly AdapterFlag[] = [
  { flag: OUTPUT, when: 'always' },
  { flag: TRUST, when: 'always' },
  { flag: PRINT, when: 'always' },
];

export function cursorCommandLine(at: { flags: readonly string[]; prompt: string; sessionId?: string; program?: string }): CommandPart[] {
  return partsWithWords([
    { words: [at.program ?? 'agent'] },
    { words: at.flags, source: 'configuration' },
    ...CURSOR_ADAPTER_FLAGS.map(({ flag }) => ({ words: [flag], source: 'adapter' as const })),
    { words: [...(at.sessionId === undefined ? [] : [`${RESUME}${at.sessionId}`]), '--', at.prompt] },
  ]);
}

export function cursorTurnCommand(at: { start: readonly string[]; sessionId: string; line: string }): string[] {
  const boundary = at.start.indexOf('--');
  const flags = (boundary === -1 ? at.start : at.start.slice(0, boundary)).filter((word) => !word.startsWith(RESUME));
  return [...flags, `${RESUME}${at.sessionId}`, '--', at.line];
}

const initSchema = z.object({ type: z.literal('system'), subtype: z.literal('init'), session_id: z.string().min(1) });

/** Init names the chat before any model call, so even an interrupted initialized turn can resume it. */
export function cursorSessionIdOf(line: string): string | undefined {
  return initSchema.safeParse(parsedLine(line)).data?.session_id;
}

const resultSchema = z.object({ type: z.literal('result'), is_error: z.boolean(), result: z.string().optional() });
const stderrSchema = z.object({ type: z.literal('aeolus.stderr'), line: z.string() });
const REFUSED_MODEL = /^Cannot use this model: (.+?)\. Available models:/u;

export function cursorErrorIn(at: { events: readonly string[]; model?: string }): { kind: 'refused'; model: string } | { kind: 'cause'; cause: string } | undefined {
  for (const line of [...at.events].reverse()) {
    const event = parsedLine(line);
    const result = resultSchema.safeParse(event).data;
    if (result?.is_error === false) return undefined;
    const cause = stderrSchema.safeParse(event).data?.line.trim() ?? (result?.is_error === true ? result.result : undefined);
    if (cause === undefined || cause === '') continue;
    const refused = REFUSED_MODEL.exec(cause)?.[1];
    return refused !== undefined && (at.model === undefined || at.model === refused) ? { kind: 'refused', model: refused } : { kind: 'cause', cause };
  }
  return undefined;
}

const activitySchema = z.object({ type: z.string(), is_error: z.boolean().optional(), exitStatus: z.number().optional(), tool_call: z.record(z.string(), z.unknown()).optional() });

/** Cursor's tool names live in native ToolCall keys, unlike Claude Code's message blocks. */
export function cursorActivityIn(events: readonly string[]): EventActivity | undefined {
  for (const line of [...events].reverse()) {
    const event = activitySchema.safeParse(parsedLine(line)).data;
    if (event === undefined) continue;
    if (event.type === 'aeolus.turn' && event.exitStatus !== undefined && event.exitStatus !== 0) return { kind: 'error' };
    if (event.type === 'result') return { kind: event.is_error === true ? 'error' : 'result' };
    if (event.type === 'assistant') return { kind: 'text' };
    if (event.type === 'tool_call') {
      const name = Object.keys(event.tool_call ?? {}).find((key) => key.endsWith('ToolCall'));
      return name === undefined ? { kind: 'tool' } : { kind: 'tool', tool: name.slice(0, -'ToolCall'.length) };
    }
  }
  return undefined;
}
