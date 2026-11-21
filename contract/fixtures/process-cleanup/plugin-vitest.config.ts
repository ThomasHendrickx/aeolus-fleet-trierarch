import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['plugins/aeolus-fleet/test/delivery.integration.test.ts'],
    setupFiles: ['plugins/aeolus-fleet/test/foreign-harness.setup.ts'],
    provide: { postgresUrl: process.env.PROCESS_CLEANUP_POSTGRES_URL ?? '' },
    testTimeout: 5_000,
    hookTimeout: 180_000,
  },
});
