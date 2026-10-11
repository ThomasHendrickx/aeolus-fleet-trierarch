import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CODEX_SCREENS_CHECKED_ON, codexLaunchSeen } from './codex-screen.js';

// On screens of Codex 0.162.1, captured from real sessions (#382, #594).

function screen(name: string): string {
  return readFileSync(new URL(`../../test/screens/codex-${name}.txt`, import.meta.url), 'utf8');
}

/** The screen as the session shows it once its first prompt is in, before it did anything. */
function promptedOnly(name: string): string {
  const lines = screen(name).split('\n');
  return lines.slice(0, lines.findIndex((line) => line.startsWith('› ')) + 1).join('\n');
}

describe('what a Codex screen shows in its launch window', () => {
  it.each(['ran', 'explored', 'refused', 'refused-default', 'woken'])('is checked on the Codex version its screen was captured on (%s)', (name) => {
    expect(screen(name)).toContain(`>_ OpenAI Codex (v${CODEX_SCREENS_CHECKED_ON})`);
  });

  it.each(['ran', 'explored'])('sees activity once its first prompt made a tool call (%s)', (name) => {
    expect(codexLaunchSeen({ screen: screen(name), model: 'gpt-5.6-sol' })).toEqual({ kind: 'active' });
  });

  it('sees none while its first prompt made no tool call', () => {
    expect(codexLaunchSeen({ screen: promptedOnly('ran'), model: 'gpt-5.6-sol' })).toEqual({ kind: 'none' });
  });

  it('sees none while it only says it is working', () => {
    expect(codexLaunchSeen({ screen: `${promptedOnly('ran')}\n\n• Working (3s • esc to interrupt)\n`, model: 'gpt-5.6-sol' })).toEqual({ kind: 'none' });
  });

  it('sees the model it launched with refused', () => {
    expect(codexLaunchSeen({ screen: screen('refused'), model: 'gpt-nonexistent-9' })).toEqual({ kind: 'refused', model: 'gpt-nonexistent-9' });
  });

  it('sees no refusal of a model other than the one it launched with', () => {
    expect(codexLaunchSeen({ screen: screen('refused'), model: 'gpt-5.6-sol' })).toEqual({ kind: 'none' });
  });

  it('sees the model refused that a session launched without one used', () => {
    expect(codexLaunchSeen({ screen: screen('refused-default') })).toEqual({ kind: 'refused', model: 'gpt-nonexistent-9' });
  });
});
