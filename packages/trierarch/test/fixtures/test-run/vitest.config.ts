import { defineConfig } from 'vitest/config';

/**
 * A suite of one test that starts a container of the test session image and
 * leaves it, under the package's own global setup: what a test run started,
 * for `test/support/test-run.test.ts` to run, interrupt and run again (#345).
 */
export default defineConfig({
  test: {
    include: ['*.fixture.ts'],
    globalSetup: ['../../support/test-run.global-setup.ts'],
    testTimeout: 600_000,
  },
});
