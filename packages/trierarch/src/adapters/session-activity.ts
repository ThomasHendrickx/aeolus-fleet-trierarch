import type { ShipId } from '@aeolus-fleet/common';
import { z } from 'zod';

import type { ActivityKind, SessionActivity, SessionRuntime } from '../core/ports.js';
import { parsedLine } from './hold-protocol.js';

/**
 * What a harness's latest event says its session is doing (monitoring 4.3,
 * headless H14): its kind and the tool when it is a tool call, never any
 * content. Each harness reads its own events, in this one place, tested on
 * events captured from real sessions.
 */
export interface EventActivity {
  readonly kind: ActivityKind;
  readonly tool?: string;
}

/** The latest event of the events, newest first, that reads as activity; none when none does. */
function latestIn(events: readonly string[], read: (event: unknown) => EventActivity | undefined): EventActivity | undefined {
  for (const line of [...events].reverse()) {
    const activity = read(parsedLine(line));
    if (activity !== undefined) {
      return activity;
    }
  }
  return undefined;
}

const claudeCodeEventSchema = z.object({
  type: z.string(),
  is_error: z.boolean().optional(),
  message: z.object({ content: z.unknown() }).optional(),
});

const claudeCodeBlocksSchema = z.array(z.object({ type: z.string(), name: z.string().optional() }));

function claudeCodeActivityOf(event: unknown): EventActivity | undefined {
  const parsed = claudeCodeEventSchema.safeParse(event);
  if (!parsed.success) {
    return undefined;
  }
  const { type, is_error: isError, message } = parsed.data;
  if (type === 'result') {
    return { kind: isError === true ? 'error' : 'result' };
  }
  const blocks = claudeCodeBlocksSchema.safeParse(message?.content);
  if (type === 'user') {
    return blocks.success && blocks.data.some((block) => block.type === 'tool_result') ? { kind: 'result' } : undefined;
  }
  if (type !== 'assistant' || !blocks.success) {
    return undefined;
  }
  const call = blocks.data.findLast((block) => block.type === 'tool_use');
  if (call !== undefined) {
    return call.name === undefined ? { kind: 'tool' } : { kind: 'tool', tool: call.name };
  }
  return blocks.data.some((block) => block.type === 'text') ? { kind: 'text' } : undefined;
}

/** A Claude Code session's activity, from its stream-json events. */
export function claudeCodeActivityIn(events: readonly string[]): EventActivity | undefined {
  return latestIn(events, claudeCodeActivityOf);
}

const codexEventSchema = z.object({ type: z.string(), item: z.object({ type: z.string() }).optional() });

function codexActivityOf(event: unknown): EventActivity | undefined {
  const parsed = codexEventSchema.safeParse(event);
  if (!parsed.success) {
    return undefined;
  }
  const { type, item } = parsed.data;
  switch (type) {
    case 'turn.completed':
      return { kind: 'result' };
    case 'turn.failed':
    case 'error':
      return { kind: 'error' };
    case 'item.started':
    case 'item.completed':
      if (item === undefined) {
        return undefined;
      }
      return item.type === 'agent_message' ? { kind: 'text' } : item.type === 'error' ? { kind: 'error' } : { kind: 'tool', tool: item.type };
    default:
      return undefined;
  }
}

/** A Codex session's activity, from its `codex exec --json` events. */
export function codexActivityIn(events: readonly string[]): EventActivity | undefined {
  return latestIn(events, codexActivityOf);
}

const copilotEventSchema = z.object({ type: z.string(), data: z.object({ toolName: z.string().optional(), content: z.string().optional() }).optional() });

function copilotActivityOf(event: unknown): EventActivity | undefined {
  const parsed = copilotEventSchema.safeParse(event);
  if (!parsed.success) {
    return undefined;
  }
  const { type, data } = parsed.data;
  switch (type) {
    case 'tool.execution_start':
      return data?.toolName === undefined ? { kind: 'tool' } : { kind: 'tool', tool: data.toolName };
    case 'tool.execution_complete':
    case 'result':
      return { kind: 'result' };
    case 'session.error':
      return { kind: 'error' };
    case 'assistant.message':
      return data?.content !== undefined && data.content !== '' ? { kind: 'text' } : undefined;
    default:
      return undefined;
  }
}

/** A Copilot session's activity, from its JSON events. */
export function copilotActivityIn(events: readonly string[]): EventActivity | undefined {
  return latestIn(events, copilotActivityOf);
}

/** What a session did last: the activity its events show, at when its runtime last saw an event written. */
export async function sessionActivityOf(at: {
  sessions: Pick<SessionRuntime, 'events' | 'lastEventAt'>;
  shipId: ShipId;
  read: (events: readonly string[]) => EventActivity | undefined;
}): Promise<SessionActivity | undefined> {
  const activity = at.read(await at.sessions.events(at.shipId));
  const wroteAt = await at.sessions.lastEventAt(at.shipId);
  return activity === undefined || wroteAt === undefined ? undefined : { at: wroteAt, ...activity };
}
