import { fileURLToPath } from 'node:url';

/**
 * The trierarch the contract suite drives, as one command line: the words of
 * AEOLUS_TRIERARCH_UNDER_TEST, split on spaces, or today's trierarch built
 * from this repository (`npm run build`) and run by this Node. Any trierarch
 * that does what docs/trierarch.md says passes the suite run with its own
 * command here; no test reaches the trierarch any other way.
 */
export const TODAYS_TRIERARCH: readonly string[] = [process.execPath, fileURLToPath(new URL('../../packages/trierarch/dist/bin/aeolus-trierarch.js', import.meta.url))];

const named = process.env.AEOLUS_TRIERARCH_UNDER_TEST?.trim();

export const TRIERARCH_UNDER_TEST: readonly string[] = named === undefined || named === '' ? TODAYS_TRIERARCH : named.split(/\s+/);

/** Whether the suite drives today's trierarch, which it builds before it runs. */
export const isTodaysTrierarch = named === undefined || named === '';
