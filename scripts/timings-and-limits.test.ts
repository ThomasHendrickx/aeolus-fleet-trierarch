import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('documents the hold event log only under trierarch timings and limits', () => {
  const timings = readFileSync(new URL('../docs/timings-and-limits.md', import.meta.url), 'utf8');
  const [trierarch, plugin] = timings.split('\n## The aeolus-fleet plugin\n');
  expect(trierarch).toContain('`eventLogLimit`');
  expect(plugin).toBeDefined();
  expect(plugin).not.toContain('`eventLogLimit`');
});
