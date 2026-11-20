import { fileURLToPath } from 'node:url';

/** The Go binary built from this repository, or a binary supplied by the caller. */
export const TODAYS_TRIERARCH: readonly string[] = [fileURLToPath(new URL('../../aeolus-trierarch', import.meta.url))];
const named = process.env.AEOLUS_TRIERARCH_UNDER_TEST?.trim();
export const TRIERARCH_UNDER_TEST: readonly string[] = named === undefined || named === '' ? TODAYS_TRIERARCH : named.split(/\s+/);
/** Whether the suite builds the binary under test itself. */
export const isTodaysTrierarch = named === undefined || named === '';
