import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Counts file sizes under a ship folder without following links outside it. */
export async function measureShipFolder(folder: string): Promise<number> {
  let size = 0;
  for (const name of await readdir(folder)) {
    const path = join(folder, name);
    const stat = await lstat(path);
    if (stat.isDirectory()) { size += await measureShipFolder(path); }
    else if (stat.isFile()) { size += stat.size; }
  }
  return size;
}
