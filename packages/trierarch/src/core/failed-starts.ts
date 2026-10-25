import { NOT_OFFERED_REASON_MAX_LENGTH, type ShipId } from '@aeolus-fleet/common';

/**
 * The machine's failed session starts (docs/trierarch.md, "Crewing a ship",
 * aeolus-fleet#853): once the last start of 3 different ships failed, with no
 * start succeeding since, the cause is the machine's, not one ship's
 * settings, so the trierarch stops offering itself for placement. It offers
 * itself again, as a probe, 10 minutes after its last failed start; a start
 * that succeeds, or another configuration, offers it for good.
 */

/** How many different ships' last starts must fail in a row before the machine stops offering itself. */
export const FAILED_START_SHIPS = 3;

/** How long after its last failed start a machine that stopped offering itself offers itself again for a probe: the restart policy's longest wait. */
export const PROBE_AFTER_MINUTES = 10;
export const PROBE_AFTER_MS = PROBE_AFTER_MINUTES * 60_000;

/** The failed starts since a start last succeeded. */
export interface FailedStarts {
  /** The ships whose last start failed, each once, in the order they first failed. */
  readonly shipIds: readonly ShipId[];
  /** Why the last start failed. */
  readonly reason: string;
  /** When the last start failed, ISO 8601. */
  readonly at: string;
  /** Set once the machine stopped offering itself: since when, and the configuration it ran with then. */
  readonly stopped?: { readonly since: string; readonly configuration: string };
}

/** How a session start ended: activity in its launch window, or a failed start of the machine's with why. */
export type StartOutcome = { readonly kind: 'succeeded'; readonly shipId: ShipId } | { readonly kind: 'failed'; readonly shipId: ShipId; readonly reason: string };

/** The failed starts after one more start, and whether that start stopped the machine offering itself, so argo is told once. */
export interface Counted {
  readonly failedStarts: FailedStarts | undefined;
  readonly isNewlyStopped: boolean;
}

/** Counts one start: a success clears the count; a failure adds its ship, and the third ship stops the machine offering itself. */
export function countStart(failedStarts: FailedStarts | undefined, at: { outcome: StartOutcome; now: Date; configuration: string }): Counted {
  const { outcome, now, configuration } = at;
  if (outcome.kind === 'succeeded') {
    return { failedStarts: undefined, isNewlyStopped: false };
  }
  const shipIds = failedStarts?.shipIds.includes(outcome.shipId) === true ? failedStarts.shipIds : [...(failedStarts?.shipIds ?? []), outcome.shipId];
  const counted = { shipIds, reason: outcome.reason, at: now.toISOString() };
  if (failedStarts?.stopped !== undefined) {
    return { failedStarts: { ...counted, stopped: failedStarts.stopped }, isNewlyStopped: false };
  }
  if (shipIds.length < FAILED_START_SHIPS) {
    return { failedStarts: counted, isNewlyStopped: false };
  }
  return { failedStarts: { ...counted, stopped: { since: now.toISOString(), configuration } }, isNewlyStopped: true };
}

/** The failed starts as the trierarch starts with this configuration: another one than it stopped with offers it again. */
export function withConfiguration(failedStarts: FailedStarts | undefined, configuration: string): FailedStarts | undefined {
  return failedStarts?.stopped !== undefined && failedStarts.stopped.configuration !== configuration ? undefined : failedStarts;
}

/** Whether the machine offers itself for placement now: always, unless it stopped and its probe is not due yet. */
export function isOffering(failedStarts: FailedStarts | undefined, now: Date): boolean {
  return failedStarts?.stopped === undefined || now.getTime() - new Date(failedStarts.at).getTime() >= PROBE_AFTER_MS;
}

/** Why the machine does not offer itself, as its report names it for each harness. */
export function notOfferedReason(failedStarts: FailedStarts): string {
  return `the starts of ${String(failedStarts.shipIds.length)} ships failed in a row; last: ${failedStarts.reason}`.slice(0, NOT_OFFERED_REASON_MAX_LENGTH);
}
