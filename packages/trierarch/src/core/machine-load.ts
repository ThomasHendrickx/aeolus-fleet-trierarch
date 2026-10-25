import type { TrierarchReportDetails } from '@aeolus-fleet/common';

/** The machine's load as a trierarch reports it (#400): memory, swap, CPU and the disk of its worktree root, machine totals only. */
export type MachineLoad = NonNullable<TrierarchReportDetails['load']>;

/** What a machine can run low on, as argo is told (#400). */
export const LOW_RESOURCES = ['memory', 'disk'] as const;

export type LowResource = (typeof LOW_RESOURCES)[number];

/** Below this share of memory available, the machine is low on memory: sessions and their watchers start to be stopped (the mac mini of 2026-10-08). */
export const LOW_MEMORY_PERCENT = 10;

/** Below this share of its worktree root's disk free, the machine is low on disk. */
export const LOW_DISK_PERCENT = 5;

/** Memory, swap and disk are reported again each time their use moves this many points. */
const USE_STEP_PERCENT = 5;

/** CPU is reported again each time its load per core moves this much. */
const LOAD_PER_CORE_STEP = 0.5;

const PERCENT = 100;

/** The share of a whole, in percent; none of a whole of nothing. */
function percentOf(part: number, whole: number): number | undefined {
  return whole > 0 ? (part / whole) * PERCENT : undefined;
}

/**
 * Policy: what the machine is low on (#400): memory below 10 % available,
 * the disk below 5 % free. A machine that says it has none of one is not
 * low on it.
 */
export function lowResourcesOf(load: MachineLoad): readonly LowResource[] {
  const memory = percentOf(load.memory.availableBytes, load.memory.totalBytes);
  const disk = percentOf(load.disk.freeBytes, load.disk.totalBytes);
  return [...(memory !== undefined && memory < LOW_MEMORY_PERCENT ? (['memory'] as const) : []), ...(disk !== undefined && disk < LOW_DISK_PERCENT ? (['disk'] as const) : [])];
}

/** The steps a load is in: the trierarch reports its load again only once one of them moves, so a load that always moves does not flood the fleet (#400). */
export interface LoadSteps {
  readonly memory: number;
  readonly swap: number;
  readonly cpu: number;
  readonly disk: number;
}

const stepOf = (value: number | undefined, step: number): number => Math.floor((value ?? 0) / step);

/** Policy: the steps of a load, in 5 points of use for memory, swap and disk, and half a load per core for CPU. */
export function loadStepsOf(load: MachineLoad): LoadSteps {
  return {
    memory: stepOf(percentOf(load.memory.totalBytes - load.memory.availableBytes, load.memory.totalBytes), USE_STEP_PERCENT),
    swap: stepOf(load.swap === undefined ? undefined : percentOf(load.swap.usedBytes, load.swap.totalBytes), USE_STEP_PERCENT),
    cpu: stepOf(load.cpu.loadAverage / load.cpu.cores, LOAD_PER_CORE_STEP),
    disk: stepOf(percentOf(load.disk.totalBytes - load.disk.freeBytes, load.disk.totalBytes), USE_STEP_PERCENT),
  };
}
