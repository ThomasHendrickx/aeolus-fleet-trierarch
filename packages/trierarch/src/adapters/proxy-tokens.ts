import { timingSafeEqual } from 'node:crypto';
import { chmod, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { idSchema, type ShipId } from '@aeolus-fleet/common';
import { z } from 'zod';

import { parsedLine } from './hold-protocol.js';
import { PLUGIN_HARNESSES, type PluginHarness } from './plugin.js';

/**
 * Each session's proxy token (headless H16): a random token of its own, kept
 * in the session's folder beside its hold's files, mode 600, with the harness
 * it may reach. The model proxy takes a token only while that hold runs, so a
 * stopped session's token is refused, and the folder goes with the session.
 */

const FILE = 'proxy-token';

const proxyTokenSchema = z.object({ harness: z.enum(PLUGIN_HARNESSES), token: z.string().min(1) });

export type ProxyToken = z.infer<typeof proxyTokenSchema>;

export async function writeProxyToken(folder: string, proxyToken: ProxyToken): Promise<void> {
  const file = join(folder, FILE);
  await writeFile(file, JSON.stringify(proxyToken), { mode: 0o600 });
  await chmod(file, 0o600);
}

/** Whether the hold whose pid file is in the folder runs. */
async function isHoldRunning(folder: string): Promise<boolean> {
  const pid = Number(await readFile(join(folder, 'hold.pid'), 'utf8').catch(() => ''));
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isSameToken(given: string, held: string): boolean {
  const left = Buffer.from(given);
  const right = Buffer.from(held);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The running session that holds the token for the harness, by its ship; none for any other token. */
export async function sessionOfToken(sessions: string, at: { harness: PluginHarness; token: string }): Promise<ShipId | undefined> {
  const folders = await readdir(sessions).catch(() => []);
  for (const name of folders) {
    const shipId = idSchema('ship').safeParse(name);
    if (!shipId.success) {
      continue;
    }
    const folder = join(sessions, name);
    const held = proxyTokenSchema.safeParse(parsedLine(await readFile(join(folder, FILE), 'utf8').catch(() => '')));
    if (held.success && held.data.harness === at.harness && isSameToken(at.token, held.data.token) && (await isHoldRunning(folder))) {
      return shipId.data;
    }
  }
  return undefined;
}
