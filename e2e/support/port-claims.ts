import { randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Ports for the end-to-end tests' servers, claimed across every test run on
 * the host: full runs in other worktrees share it (#686). A port found free
 * is only free until something else binds it, and next dev binds its port
 * seconds after it is chosen. So ports come from below the ephemeral range,
 * where no listen on port 0 and no container's mapped port lands, and a run
 * claims each one with a file no other run passes over while it lives.
 *
 * A claim is a file named for its port, its process and itself: every claim
 * is a new file, so two runs never write one. A run writes its claim first,
 * then looks for others on that port; of two runs at once, the later one to
 * look sees the earlier one's, so at most one keeps it. A claim lasts as
 * long as the process that made it.
 */
export interface PortClaims {
  first: number;
  last: number;
  claimsDirectory: string;
}

/** Below Linux's ephemeral range (32768 on) and macOS's (49152 on). */
const DEFAULT_PORT_CLAIMS: PortClaims = {
  first: 20_000,
  last: 29_999,
  claimsDirectory: join(tmpdir(), 'aeolus-fleet-e2e-ports'),
};

/** A port no other run claimed and nothing listens on, claimed for as long as this process lives. */
export async function claimFreePort(where: PortClaims = DEFAULT_PORT_CLAIMS): Promise<number> {
  await mkdir(where.claimsDirectory, { recursive: true });
  const count = where.last - where.first + 1;
  // A random start, so runs at once seldom try the same port first.
  const start = randomInt(count);
  for (let offset = 0; offset < count; offset += 1) {
    const port = where.first + ((start + offset) % count);
    if (await claim(port, where.claimsDirectory)) {
      return port;
    }
  }
  throw new Error(`no free port from ${String(where.first)} to ${String(where.last)}`);
}

async function claim(port: number, claimsDirectory: string): Promise<boolean> {
  const own = `${String(port)}-${String(process.pid)}-${randomUUID()}`;
  await writeFile(join(claimsDirectory, own), '');
  const others = (await readdir(claimsDirectory)).filter((name) => name !== own && name.startsWith(`${String(port)}-`));
  const isHeld = (await Promise.all(others.map((name) => isLive(name, claimsDirectory)))).includes(true);
  if (isHeld || !(await isFree(port))) {
    await unlink(join(claimsDirectory, own));
    return false;
  }
  return true;
}

/** Whether the process that made a claim lives; a claim of one that ended is removed. */
async function isLive(name: string, claimsDirectory: string): Promise<boolean> {
  const pid = Number(name.split('-')[1]);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') {
      return true;
    }
    // Another run may have removed it first.
    await unlink(join(claimsDirectory, name)).catch(() => undefined);
    return false;
  }
}

/** Whether nothing listens on the port, on every address, as next dev listens. */
async function isFree(port: number): Promise<boolean> {
  const probe = createServer();
  probe.listen(port);
  try {
    // once rejects with the probe's error: something listens there.
    await once(probe, 'listening');
  } catch {
    return false;
  }
  probe.close();
  await once(probe, 'close');
  return true;
}
