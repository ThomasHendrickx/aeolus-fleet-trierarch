import type { HarnessUsage } from './read-usage.js';

type Window = HarnessUsage['subscriptions'][number]['windows'][number];

/** How long a window is, as a person says it: 5-hour, 7-day, or in minutes when it is neither. */
function lengthOf(windowMinutes: number): string {
  const day = 24 * 60;
  if (windowMinutes % day === 0) {
    return `${String(windowMinutes / day)}-day`;
  }
  return windowMinutes % 60 === 0 ? `${String(windowMinutes / 60)}-hour` : `${String(windowMinutes)}-minute`;
}

/** A time as `2026-10-06 11:00 UTC`. */
const utcOf = (at: Date): string => `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * Why a harness is not offered while its subscription has a window used up
 * (aeolus-fleet-trierarch#263): a window at 100% holds until it resets, so the one that
 * resets last decides. None while no window is used up, or each has reset.
 */
export function usedUpReason(windows: readonly Window[], now: Date): string | undefined {
  const holding = windows
    .map((window) => ({ window, resetsAt: new Date(window.resetsAt) }))
    .filter(({ window, resetsAt }) => window.usedPercent >= 100 && resetsAt.getTime() > now.getTime())
    .sort((left, right) => right.resetsAt.getTime() - left.resetsAt.getTime())[0];
  return holding === undefined ? undefined : `its ${lengthOf(holding.window.windowMinutes)} subscription window is used up until ${utcOf(holding.resetsAt)}`;
}
