import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { claudeCodeScreenStoppedAt } from './claude-code-screen.js';

// On screens of Claude Code 2.1.295, its first-run screens captured from a fresh home (#403).

function screen(name: string): string {
  return readFileSync(new URL(`../../test/screens/claude-code-${name}.txt`, import.meta.url), 'utf8');
}

describe('the Claude Code screen a session stopped at before its hooks ran (#490)', () => {
  it.each([
    ['theme', 'theme picker'],
    ['login', 'login method question'],
    ['security-notes', 'security notes'],
    ['trust', 'folder trust question'],
    ['bypass', 'bypass permissions warning'],
    ['fullscreen', 'fullscreen renderer offer'],
  ])('names the first-run screen it stopped at (%s)', (name, shown) => {
    expect(claudeCodeScreenStoppedAt(screen(name))).toBe(shown);
  });

  it('names none on a screen it does not know', () => {
    expect(claudeCodeScreenStoppedAt('❯ /aeolus-fleet:wake\n')).toBeUndefined();
  });
});
