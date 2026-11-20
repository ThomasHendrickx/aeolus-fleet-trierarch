import { defineConfig } from 'vitest/config';

declare module 'vitest' {
  export interface ProvidedContext {
    postgresUrl: string;
  }
}

export default defineConfig({
  test: {
    include: ['contract/fixtures/process-cleanup/fixture.ts'],
    provide: { postgresUrl: process.env.PROCESS_CLEANUP_POSTGRES_URL ?? '' },
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
