import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { codexModelRefusedIn } from './codex-session-log.js';

// On session logs (rollout files) of Codex 0.162.0, captured from real sessions in tmux and codex exec, with account ids redacted and long texts elided (#490).
// Codex documents no format for them: when a recapture on a newer Codex fails here, its format changed, and the reader must follow it.

function log(name: string): string {
  return readFileSync(new URL(`../../test/logs/codex-${name}.jsonl`, import.meta.url), 'utf8');
}

/** The refused log with its last entry, the failed turn, changed by the edit given. */
function withFailedTurn(edit: (failed: string) => string): string {
  const lines = log('refused').trimEnd().split('\n');
  return [...lines.slice(0, -1), edit(lines.at(-1) ?? '')].join('\n');
}

describe("what a Codex session's log says of its launch", () => {
  it('reads from a real log the model it launched with refused', () => {
    expect(codexModelRefusedIn({ log: log('refused'), model: 'gpt-nonexistent-9' })).toBe('gpt-nonexistent-9');
  });

  it('reads the model refused that a session launched without one used', () => {
    expect(codexModelRefusedIn({ log: log('refused') })).toBe('gpt-nonexistent-9');
  });

  it('sees no refusal of a model other than the one it launched with', () => {
    expect(codexModelRefusedIn({ log: log('refused'), model: 'gpt-5.6-sol' })).toBeUndefined();
  });

  it('sees no refusal in a real log of a turn Codex answered', () => {
    expect(codexModelRefusedIn({ log: log('answered') })).toBeUndefined();
  });

  it('sees no refusal in a turn that failed for another reason', () => {
    const otherFailure = withFailedTurn((failed) => failed.replace('invalid_request_error', 'server_error'));

    expect(codexModelRefusedIn({ log: otherFailure })).toBeUndefined();
  });

  it('sees no refusal in a turn that is only text naming one, as when a ship discusses it', () => {
    const discussed = withFailedTurn((failed) => failed.replace('"type":"task_complete"', '"type":"agent_message"'));

    expect(codexModelRefusedIn({ log: discussed })).toBeUndefined();
  });

  it('skips a last line Codex has not written in full yet', () => {
    expect(codexModelRefusedIn({ log: `${log('refused')}{"timestamp":"2026-10-12T06:35:51.000Z","type":"event_` })).toBe('gpt-nonexistent-9');
  });
});
