import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CODEX_SCREENS_CHECKED_ON, codexModelRefused, codexScreenStoppedAt } from './codex-screen.js';

// On screens of Codex 0.162.1, captured from real sessions (#382, #594), its folder trust and hooks review screens too (#602).

function screen(name: string): string {
  return readFileSync(new URL(`../../test/screens/codex-${name}.txt`, import.meta.url), 'utf8');
}

describe('what a Codex screen shows in its launch window', () => {
  it.each(['refused', 'refused-default', 'woken'])('is checked on the Codex version its screen was captured on (%s)', (name) => {
    expect(screen(name)).toContain(`>_ OpenAI Codex (v${CODEX_SCREENS_CHECKED_ON})`);
  });

  it.each([
    ['trust', 'folder trust question'],
    ['hooks', 'hooks review'],
  ])('names the screen it stopped at before its first prompt (%s)', (name, shown) => {
    expect(codexScreenStoppedAt(screen(name))).toBe(shown);
  });

  it('names none on a screen it does not know', () => {
    expect(codexScreenStoppedAt(screen('woken'))).toBeUndefined();
  });

  it('sees the model it launched with refused', () => {
    expect(codexModelRefused({ screen: screen('refused'), model: 'gpt-nonexistent-9' })).toBe('gpt-nonexistent-9');
  });

  it('sees no refusal of a model other than the one it launched with', () => {
    expect(codexModelRefused({ screen: screen('refused'), model: 'gpt-5.6-sol' })).toBeUndefined();
  });

  it('sees the model refused that a session launched without one used', () => {
    expect(codexModelRefused({ screen: screen('refused-default') })).toBe('gpt-nonexistent-9');
  });
});
