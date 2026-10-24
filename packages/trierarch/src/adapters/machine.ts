import { readFile, statfs } from 'node:fs/promises';
import { availableParallelism, freemem, loadavg, totalmem } from 'node:os';
import { dirname } from 'node:path';

import type { MachineLoad } from '../core/machine-load.js';
import type { MachinePort } from '../core/ports.js';
import { runCommand } from './run-command.js';

/**
 * The machine's load as its operating system says it (#400). Memory: on Linux
 * Node's free memory is what /proc/meminfo calls available; on a Mac it counts
 * only free pages, so the free, inactive, speculative and purgeable pages of
 * vm_stat are read instead, as Activity Monitor counts what is not used.
 * Swap from /proc/meminfo or sysctl, none elsewhere. CPU: the 1-minute load
 * average over the cores. Disk: the filesystem of the worktree root, or of
 * the folder it will be made in.
 */

type Memory = MachineLoad['memory'];
type Swap = NonNullable<MachineLoad['swap']>;

const KIB = 1024;
const MIB = 1024 ** 2;

/** A /proc/meminfo field, in bytes; none when it is not there. */
function meminfoField(meminfo: string, name: string): number | undefined {
  const kib = new RegExp(`^${name}:\\s+(\\d+) kB$`, 'mu').exec(meminfo)?.[1];
  return kib === undefined ? undefined : Number(kib) * KIB;
}

/** The swap a Linux machine has and uses, from /proc/meminfo. */
export function linuxSwapOf(meminfo: string): Swap | undefined {
  const total = meminfoField(meminfo, 'SwapTotal');
  const free = meminfoField(meminfo, 'SwapFree');
  return total === undefined || free === undefined ? undefined : { totalBytes: total, usedBytes: total - free };
}

/** A vm_stat count of pages; 0 when it is not there. */
function pagesOf(vmStat: string, name: string): number {
  return Number(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.$`, 'mu').exec(vmStat)?.[1] ?? 0);
}

/** The memory a Mac has, from `sysctl -n hw.memsize`, and what of it is available, from vm_stat. */
export function macosMemoryOf(at: { memsize: string; vmStat: string }): Memory {
  const pageSize = Number(/page size of (\d+) bytes/u.exec(at.vmStat)?.[1] ?? 0);
  const pages = ['free', 'inactive', 'speculative', 'purgeable'].reduce((sum, name) => sum + pagesOf(at.vmStat, name), 0);
  return { totalBytes: Number(at.memsize.trim()), availableBytes: pages * pageSize };
}

/** The swap a Mac has and uses, from `sysctl -n vm.swapusage`. */
export function macosSwapOf(swapUsage: string): Swap | undefined {
  const bytesOf = (name: string): number | undefined => {
    const megabytes = new RegExp(`${name} = (\\d+(?:\\.\\d+)?)M`, 'u').exec(swapUsage)?.[1];
    return megabytes === undefined ? undefined : Math.round(Number(megabytes) * MIB);
  };
  const total = bytesOf('total');
  const used = bytesOf('used');
  return total === undefined || used === undefined ? undefined : { totalBytes: total, usedBytes: used };
}

async function sysctl(name: string): Promise<string> {
  return (await runCommand('sysctl', { args: ['-n', name] })).stdout;
}

/** The filesystem of the folder, or of the nearest folder above it that exists. */
async function diskOf(folder: string): Promise<MachineLoad['disk']> {
  try {
    const stats = await statfs(folder);
    return { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
  } catch (error) {
    const parent = dirname(folder);
    if (parent === folder || !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
    return diskOf(parent);
  }
}

export function createMachine(at: { worktreeRoot: string; platform?: NodeJS.Platform }): MachinePort {
  const platform = at.platform ?? process.platform;
  const memoryAndSwap = async (): Promise<{ memory: Memory; swap?: Swap }> => {
    if (platform === 'darwin') {
      const [memsize, vmStat, swapUsage] = await Promise.all([sysctl('hw.memsize'), runCommand('vm_stat', { args: [] }).then((result) => result.stdout), sysctl('vm.swapusage')]);
      const swap = macosSwapOf(swapUsage);
      return { memory: macosMemoryOf({ memsize, vmStat }), ...(swap !== undefined && { swap }) };
    }
    const memory = { totalBytes: totalmem(), availableBytes: freemem() };
    const swap = platform === 'linux' ? linuxSwapOf(await readFile('/proc/meminfo', 'utf8')) : undefined;
    return { memory, ...(swap !== undefined && { swap }) };
  };
  return {
    load: async () => {
      const [{ memory, swap }, disk] = await Promise.all([memoryAndSwap(), diskOf(at.worktreeRoot)]);
      return { memory, ...(swap !== undefined && { swap }), cpu: { cores: availableParallelism(), loadAverage: loadavg()[0] ?? 0 }, disk };
    },
  };
}
