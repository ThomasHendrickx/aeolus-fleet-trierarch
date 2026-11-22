/**
 * The trierarch's timings as the contract suite runs it: with its test
 * timing setting, every timing it names divided by `TIMING_DIVISOR`
 * (docs/timings-and-limits.md), whether the suite built the trierarch or
 * `AEOLUS_TRIERARCH_UNDER_TEST` names a build, as CI does. A machine at
 * `production` timings runs without the setting, for the tests that prove
 * each production value.
 */

/** The variable the trierarch reads its test timing setting from. */
export const TIMING_VARIABLE = 'AEOLUS_TRIERARCH_TEST_TIMING_DIVISOR';

/** How much shorter the suite runs the trierarch's timings. */
export const TIMING_DIVISOR = 5;

/** The timings a machine runs the trierarch at. */
export type Timings = 'shortened' | 'production';

/** The production pass interval, as docs/timings-and-limits.md gives it. */
export const PRODUCTION_PASS_INTERVAL_MS = 5_000;
/** The production wait for one stable service process before init reports success. */
export const PRODUCTION_INIT_STABILITY_MS = 10_000;
/** The production wait before the first restart of a session that died. */
export const PRODUCTION_FIRST_RESTART_DELAY_MS = 5_000;

/** The pass interval the suite runs the trierarch at. */
export const PASS_INTERVAL_MS = PRODUCTION_PASS_INTERVAL_MS / TIMING_DIVISOR;
/** The first restart delay the suite runs the trierarch at. */
export const FIRST_RESTART_DELAY_MS = PRODUCTION_FIRST_RESTART_DELAY_MS / TIMING_DIVISOR;

/**
 * Long enough for a pass or two and the wait before a session would start
 * again: two passes, the first restart delay, and one pass more for the
 * passes' own work. A test that sees nothing happen within it saw at least
 * two passes.
 */
export const PASSES_MS = 3 * PASS_INTERVAL_MS + FIRST_RESTART_DELAY_MS;

/** The variables a machine runs the trierarch with for its timings. */
export function timingVariablesOf(timings: Timings): Readonly<Record<string, string>> {
  return timings === 'shortened' ? { [TIMING_VARIABLE]: String(TIMING_DIVISOR) } : {};
}
