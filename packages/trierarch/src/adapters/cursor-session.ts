import { z } from 'zod';

import type { AdapterFlag } from '../core/ports.js';
import { partsWithWords, type CommandPart } from './command-line.js';
import { parsedLine } from './hold-protocol.js';

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
