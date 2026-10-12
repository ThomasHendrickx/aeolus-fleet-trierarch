import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { codexScreenStoppedAt } from './codex-screen.js';

// On screens of Codex 0.162.1 captured from real sessions: its folder trust and hooks review screens (#602), and one it stopped at none of.

function screen(name: string): string {
  return readFileSync(new URL(`../../test/screens/codex-${name}.txt`, import.meta.url), 'utf8');
}

describe('what a Codex screen shows in its launch window', () => {
  it.each([
    ['trust', 'folder trust question'],
    ['hooks', 'hooks review'],
  ])('names the screen it stopped at before its first prompt (%s)', (name, shown) => {
    expect(codexScreenStoppedAt(screen(name))).toBe(shown);
  });

  it('names none on a screen it does not know', () => {
    expect(codexScreenStoppedAt(screen('woken'))).toBeUndefined();
  });
});
