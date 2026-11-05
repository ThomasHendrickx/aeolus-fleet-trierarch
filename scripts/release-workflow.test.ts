import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const WORKFLOW = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

function stepNames(): string[] {
  return [...WORKFLOW.matchAll(/^ {6}- name: (.+)$/gm)].map((match) => match[1] ?? '');
}

function stepIndex(prefix: string): number {
  return stepNames().findIndex((name) => name.startsWith(prefix));
}

describe('the release workflow', () => {
  it('updates the Homebrew tap after the plugin version is set on main, so a tap failure leaves the plugin step run', () => {
    const plugin = stepIndex('Set the aeolus-fleet plugin to');
    const tap = stepIndex('Update the Homebrew tap to');
    expect(plugin).toBeGreaterThan(-1);
    expect(tap).toBeGreaterThan(plugin);
  });
});
