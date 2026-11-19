import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { discard } from './trash.js';

/** Cache measurement runs at most hourly and leaves recently modified units alone. */
const HOUR_MS = 60 * 60 * 1000;

interface Measure {
  readonly bytes: number;
  readonly modified: number;
}

/** Measures without following links, including the newest modification anywhere in a unit. */
async function measure(path: string): Promise<Measure> {
  const info = await lstat(path);
  if (!info.isDirectory()) return { bytes: info.size, modified: info.mtimeMs };
  const entries = await readdir(path);
  const children = await Promise.all(entries.map(async (name) => measure(join(path, name))));
  return { bytes: children.reduce((total, child) => total + child.bytes, 0), modified: children.reduce((newest, child) => Math.max(newest, child.modified), info.mtimeMs) };
}

async function directories(path: string): Promise<string[]> {
  const info = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (info?.isDirectory() !== true) return [];
  const entries = await readdir(path, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name));
}

/** Trims whole tool-managed units, never following links or touching a person's cache. */
export function createSessionCache(options: { root: string; maxBytes?: number }): { trim(now: Date): Promise<void> } {
  let lastCheck: number | undefined;
  let isRunning = false;
  return {
    trim: async (now) => {
      const { root, maxBytes } = options;
      const time = now.getTime();
      if (maxBytes === undefined || isRunning || (lastCheck !== undefined && time - lastCheck < HOUR_MS)) return;
      isRunning = true;
      lastCheck = time;
      try {
        const rootInfo = await lstat(root).catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
          throw error;
        });
        if (rootInfo === undefined) return;
        if (!rootInfo.isDirectory()) throw new Error(`The session cache ${root} is no directory`);
        const top = await directories(root);
        const names = ['npm', 'go-build', 'go-mod'];
        const whole = top.filter((path) => names.some((name) => path === join(root, name)));
        const units = [...whole, ...(await directories(join(root, 'xdg'))), ...(await directories(join(root, 'ms-playwright')))];
        const measured = await Promise.all(units.map(async (path) => ({ path, ...(await measure(path)) })));
        // Count all data under the cache, including files that are not eviction units, but never its trash.
        const all = (await readdir(root).catch(() => [])).filter((name) => name !== '.trash');
        let bytes = (await Promise.all(all.map(async (name) => measure(join(root, name))))).reduce((sum, item) => sum + item.bytes, 0);
        const ordered = measured.sort((a, b) => a.modified - b.modified);
        let index = 0;
        for (const unit of ordered) {
          if (bytes <= maxBytes) break;
          if (unit.modified > time - HOUR_MS) continue;
          if ((await measure(unit.path)).modified > time - HOUR_MS) continue;
          await discard(unit.path, { at: new Date(time + index), into: root });
          index += 1;
          bytes -= unit.bytes;
        }
      } finally {
        isRunning = false;
      }
    },
  };
}
