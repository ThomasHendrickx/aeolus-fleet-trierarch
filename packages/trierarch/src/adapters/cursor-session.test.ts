import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { wordsOf } from './command-line.js';
import { cursorCommandLine, cursorErrorIn, cursorSessionIdOf, cursorTurnCommand } from './cursor-session.js';

const fixture = (name: string) => readFileSync(new URL(`../../../../plugins/aeolus-fleet/test/fixtures/cursor/2026.11.13-eacade1/linux/${name}`, import.meta.url), 'utf8').trim().split('\n');

describe('Cursor turn commands and captured events (CC4, H13)', () => {
  it('prints stream-json in a trusted workspace and keeps the prompt after the option boundary', () => {
    expect(wordsOf(cursorCommandLine({ flags: ['--model', 'auto'], prompt: '-v' }))).toEqual(['agent', '--model', 'auto', '--output-format=stream-json', '--trust', '--print', '--', '-v']);
  });

  it('resumes each later chat with the configured flags, replacing the previous prompt and chat id', () => {
    const start = wordsOf(cursorCommandLine({ flags: ['--force'], prompt: 'old', sessionId: 'old-chat' }));
    expect(cursorTurnCommand({ start, sessionId: 'new-chat', line: '-new prompt' })).toEqual(['agent', '--force', '--output-format=stream-json', '--trust', '--print', '--resume=new-chat', '--', '-new prompt']);
  });

  it('reads the chat id at system init before a successful or interrupted result', () => {
    expect(cursorSessionIdOf(fixture('first.events.jsonl')[0] ?? '')).toBe('00000000-0000-4000-8000-000000000001');
    expect(cursorSessionIdOf('not json')).toBeUndefined();
    expect(cursorSessionIdOf('{"type":"assistant","session_id":"other"}')).toBeUndefined();
  });

  it('recognizes the captured refused model from stderr, only for the launched model', () => {
    const events = fixture('failed.stderr').map((line) => JSON.stringify({ type: 'aeolus.stderr', line }));
    expect(cursorErrorIn({ events, model: 's7-nonexistent-model' })).toEqual({ kind: 'refused', model: 's7-nonexistent-model' });
    expect(cursorErrorIn({ events, model: 'auto' })?.kind).toBe('cause');
  });

  it('clears an earlier launch error after a successful result', () => {
    expect(cursorErrorIn({ events: ['{"type":"aeolus.stderr","line":"Authentication required"}', '{"type":"result","is_error":false}'] })).toBeUndefined();
  });
});
