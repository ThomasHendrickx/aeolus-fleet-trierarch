import { randomInt } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';

import { CHECK_INTERVAL_MS, createModelProxy } from '../adapters/model-proxy.js';
import { keyStatesFileOf, proxyFilesOf } from '../adapters/proxy-runtime.js';
import { runningVersion } from '../adapters/version.js';

/**
 * `aeolus-trierarch proxy --folder <folder> --sessions <folder> --keys <folder>`:
 * the model proxy (headless H16), as the trierarch starts it, never a person.
 * It listens on loopback, on the port it listened on before when it can, so a
 * running session reaches it where it did, else on a port below the ephemeral
 * ranges (Linux's from 32768, macOS's from 49152), which no port-0 listener or
 * outbound connection is given while it is gone; it writes its port and pid in its
 * folder, checks each key out of credit every 15 minutes, and ends on SIGTERM.
 */

const LOOPBACK = '127.0.0.1';
/** Where a port of its own is picked: above the well-known and below every ephemeral range. */
const OWN_PORTS = { from: 10_000, below: 32_768 };
/** How many picked ports it tries before it gives up on a start. */
const OWN_PORT_TRIES = 20;

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOOPBACK, () => {
      server.off('error', reject);
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : port);
    });
  });
}

/** Listens on a port picked among its own, trying another while one is taken. */
async function listenOnAnOwnPort(server: Server, tries = OWN_PORT_TRIES): Promise<number> {
  const port = randomInt(OWN_PORTS.from, OWN_PORTS.below);
  return listen(server, port).catch((error: unknown) => {
    if (tries <= 1) throw error;
    return listenOnAnOwnPort(server, tries - 1);
  });
}

/** Runs the proxy with the words after `proxy`; answers its exit code, or 2 for words it cannot take. */
export async function proxyCommand(words: readonly string[]): Promise<number> {
  const valueOf = (name: string): string | undefined => (words.includes(name) ? words[words.indexOf(name) + 1] : undefined);
  const folder = valueOf('--folder');
  const sessions = valueOf('--sessions');
  const keys = valueOf('--keys');
  if (folder === undefined || sessions === undefined || keys === undefined) {
    process.stderr.write('Usage: aeolus-trierarch proxy --folder <folder> --sessions <folder> --keys <folder>\n');
    return 2;
  }
  const files = proxyFilesOf(folder);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const proxy = createModelProxy({ sessions, keys, keyStates: keyStatesFileOf(folder), version: runningVersion() });
  const server = createServer(proxy.handle);
  const before = Number(await readFile(files.port, 'utf8').catch(() => ''));
  // The port it had may be taken by now: then one of its own, and sessions started from now reach it there.
  const port = Number.isInteger(before) && before > 0 ? await listen(server, before).catch(() => listenOnAnOwnPort(server)) : await listenOnAnOwnPort(server);
  await writeFile(files.port, String(port));
  await writeFile(files.pid, String(process.pid));
  // A key out of credit is checked every 15 minutes (api keys K10); a check that fails is tried again at the next.
  const checks = setInterval(() => {
    proxy.checkOutOfCredit().catch(() => undefined);
  }, CHECK_INTERVAL_MS);
  await new Promise<void>((resolve) => {
    process.once('SIGTERM', () => {
      clearInterval(checks);
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
  });
  return 0;
}
