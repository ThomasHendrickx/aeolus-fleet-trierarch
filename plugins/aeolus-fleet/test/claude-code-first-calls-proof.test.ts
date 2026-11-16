/** A recorded fresh Claude Code session, crewed with this plugin, whose first setStatement and first reply both pass (#478). */
import { readFileSync } from 'node:fs';

import { sendInputSchema, setStatementInputSchema } from '@aeolus-fleet/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const capture = readFileSync(new URL('./fixtures/claude-code/2.1.323/linux/first-calls.events.jsonl', import.meta.url), 'utf8');
const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tool_use'), tool: z.string(), input: z.object({ command: z.string() }).or(z.object({ skill: z.string() })) }),
  z.object({ type: z.literal('tool_result'), is_error: z.boolean(), content: z.string() }),
  z.object({ type: z.literal('result'), subtype: z.string(), is_error: z.boolean(), num_turns: z.number() }),
]);
const events = capture.trim().split('\n').map((line) => eventSchema.parse(JSON.parse(line)));
const commands = events.flatMap((event, index) => (event.type === 'tool_use' && 'command' in event.input ? [{ command: event.input.command, answer: events[index + 1] }] : []));
// Each call reads its input from a quoted heredoc: `<call> - <<'JSON'`, the JSON, then `JSON`.
const heredocInputs = (call: string) => commands.flatMap(({ command }) => [...command.matchAll(new RegExp(`aeolus-fleet\\.sh" ${call} - <<'JSON'\\n(.*)\\nJSON`, 'g'))].map((match) => z.unknown().parse(JSON.parse(match[1] ?? 'null'))));
// Ids are scrubbed to placeholders; put a well-formed one back to check the shape.
const withIds = (input: unknown): unknown => z.unknown().parse(JSON.parse(JSON.stringify(input).replace('"<msg id>"', '"msg_01m7k9nka3stfxsbx1da02d6qn"')));

describe('a fresh Claude Code 2.1.323 session crewed with the plugin: its first setStatement and first reply', () => {
  it('makes exactly one setStatement and one send, each in the shape the fleet accepts', () => {
    const statements = heredocInputs('setStatement');
    const sends = heredocInputs('send');

    expect(statements).toHaveLength(1);
    expect(sends).toHaveLength(1);
    expect(setStatementInputSchema.safeParse(statements[0]).success).toBe(true);
    expect(sendInputSchema.safeParse(withIds(sends[0])).success).toBe(true);
    expect(sends[0]).toMatchObject({ selector: { kind: 'ship', name: 'fix-tri-481' }, inReplyTo: '<msg id>' });
  });

  it('gets the fleet\'s acceptance for both at once: a messageId for the reply and version 1 for the statement', () => {
    const call = commands.find(({ command }) => command.includes('setStatement -'));

    expect(call?.answer).toMatchObject({ type: 'tool_result', is_error: false });
    const answers = call?.answer?.type === 'tool_result' ? call.answer.content.split('\n---\n') : [];
    expect(answers[0]).toBe('{"messageId":"<msg id>"}');
    expect(answers[1]).toBe('{"version":1}');
    expect(capture).not.toMatch(/VALIDATION|refused|invalid/i);
  });

  it('keeps no id, token, path, computer or skill name of the run', () => {
    expect(capture).not.toMatch(/\b(?:shp|msg|dlv|flt|toolu)_[0-9a-z]/i);
    expect(capture).not.toMatch(/\b[0-7][0-9a-hjkmnp-tv-z]{25}\b/);
    expect(capture).not.toMatch(/aeolus_sk_|aeolus_ct_|\/home\/|\/Users\/|\/tmp\//);
    expect(capture).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    for (const event of events) {
      if (event.type === 'tool_use' && 'skill' in event.input) expect(event.input.skill).toBe('<skill>');
    }
  });
});
