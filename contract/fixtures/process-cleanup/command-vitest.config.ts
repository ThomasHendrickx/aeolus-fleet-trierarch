import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['contract/fixtures/process-cleanup/command-fixture.ts'],
    testTimeout: 30_000,
    hookTimeout: 5_000,
  },
});
