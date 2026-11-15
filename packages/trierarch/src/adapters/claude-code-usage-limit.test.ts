import { describe, expect, it } from 'vitest';

import { claudeCodeUsageLimitIn } from './claude-code-usage-limit.js';

const message = "You've hit your usage limit. Try again after 2026-11-15 18:00 UTC.";
const stopped = JSON.stringify({ type: 'result', uuid: 'stop-1', is_error: true, result: message });

describe('a Claude Code usage-limit stop (#1629)', () => {
  it('keeps the reason, reset information and occurrence from an error result', () => {
    expect(claudeCodeUsageLimitIn([stopped])).toEqual({ occurrence: 'stop-1', reason: message });
  });

  it('recognises the assistant rate-limit error followed by an error result', () => {
    const assistant = JSON.stringify({ type: 'assistant', uuid: 'assistant-1', error: 'rate_limit', message: { content: [{ type: 'text', text: message }] } });
    expect(claudeCodeUsageLimitIn([assistant, JSON.stringify({ type: 'result', uuid: 'stop-2', is_error: true, errors: [message] })])).toEqual({ occurrence: 'assistant-1', reason: message });
  });

  it('does not report ordinary text, other errors or a recovered turn as a limit stop', () => {
    expect(claudeCodeUsageLimitIn([JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: message }] } })])).toBeUndefined();
    expect(claudeCodeUsageLimitIn([JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in' })])).toBeUndefined();
    expect(claudeCodeUsageLimitIn([stopped, JSON.stringify({ type: 'result', is_error: false, result: 'Done' })])).toBeUndefined();
  });
});

it('keeps one occurrence while the assistant error becomes the turn result (#1629)', () => {
  const assistant = JSON.stringify({ type: 'assistant', uuid: 'assistant-1', error: 'rate_limit', message: { content: [{ type: 'text', text: message }] } });
  const result = JSON.stringify({ type: 'result', uuid: 'result-1', is_error: true, errors: [message] });
  expect(claudeCodeUsageLimitIn([assistant])).toEqual({ occurrence: 'assistant-1', reason: message });
  expect(claudeCodeUsageLimitIn([assistant, result])).toEqual({ occurrence: 'assistant-1', reason: message });
  expect(claudeCodeUsageLimitIn([assistant, result, JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in' })])).toBeUndefined();
});
