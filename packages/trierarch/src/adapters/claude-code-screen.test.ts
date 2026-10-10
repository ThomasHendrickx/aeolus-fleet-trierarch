import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { claudeCodeLaunchSeen } from './claude-code-screen.js';

// On screens of Claude Code 2.1.295, captured from real sessions (#382), its first-run screens from a fresh home (#403).
// On Linux it draws ● where macOS draws ⏺ (#487).

function screen(name: string): string {
  return readFileSync(new URL(`../../test/screens/claude-code-${name}.txt`, import.meta.url), 'utf8');
}

/** The screen as the session shows it once its first prompt is in, before it did anything. */
function promptedOnly(name: string): string {
  const lines = screen(name).split('\n');
  return lines.slice(0, lines.findIndex((line) => line.startsWith('❯ ')) + 1).join('\n');
}

describe('what a Claude Code screen shows in its launch window', () => {
  it.each(['ran', 'read', 'called', 'skill'])('sees activity once its first prompt made a tool call (%s)', (name) => {
    expect(claudeCodeLaunchSeen({ screen: screen(name), model: 'claude-opus-5-5' })).toEqual({ kind: 'active' });
  });

  it('sees activity once its first prompt made a tool call on Linux', () => {
    expect(claudeCodeLaunchSeen({ screen: screen('linux'), model: 'claude-opus-5-5' })).toEqual({ kind: 'active' });
  });

  it.each(['⏺', '●'])('sees activity while a tool call runs (%s)', (glyph) => {
    expect(claudeCodeLaunchSeen({ screen: `${promptedOnly('read')}\n\n${glyph} Reading 1 file…\n`, model: 'claude-opus-5-5' })).toEqual({ kind: 'active' });
  });

  it('sees none while its first prompt made no tool call on Linux', () => {
    expect(claudeCodeLaunchSeen({ screen: `${promptedOnly('linux')}\n\n● Done.\n`, model: 'claude-opus-5-5' })).toEqual({ kind: 'none' });
  });

  it('sees none while its first prompt made no tool call', () => {
    expect(claudeCodeLaunchSeen({ screen: promptedOnly('ran'), model: 'claude-opus-5-5' })).toEqual({ kind: 'none' });
  });

  it.each([
    ['theme', 'theme picker'],
    ['login', 'login method question'],
    ['security-notes', 'security notes'],
    ['trust', 'folder trust question'],
    ['bypass', 'bypass permissions warning'],
    ['fullscreen', 'fullscreen renderer offer'],
  ])('names the first-run screen it stopped at (%s)', (name, shown) => {
    expect(claudeCodeLaunchSeen({ screen: screen(name), model: 'claude-opus-5-5' })).toEqual({ kind: 'none', screen: shown });
  });

  it('sees the model it launched with refused', () => {
    expect(claudeCodeLaunchSeen({ screen: screen('refused'), model: 'claude-nonexistent-9' })).toEqual({ kind: 'refused', model: 'claude-nonexistent-9' });
  });

  it('sees no refusal of a model other than the one it launched with', () => {
    expect(claudeCodeLaunchSeen({ screen: screen('refused'), model: 'claude-opus-5-5' })).toEqual({ kind: 'none' });
  });

  it('sees the model refused that a session launched without one used', () => {
    expect(claudeCodeLaunchSeen({ screen: screen('refused') })).toEqual({ kind: 'refused', model: 'claude-nonexistent-9' });
  });
});
