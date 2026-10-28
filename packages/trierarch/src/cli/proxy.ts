import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';

import { createModelProxy } from '../adapters/model-proxy.js';
import { proxyFilesOf } from '../adapters/proxy-runtime.js';
import { runningVersion } from '../adapters/version.js';

/**
 * `aeolus-trierarch proxy --folder <folder> --sessions <folder> --keys <folder>`:
 * the model proxy (headless H16), as the trierarch starts it, never a person.
 * It listens on loopback, on the port it listened on before when it can, so a
 * running session reaches it where it did; it writes its port and pid in its
 * folder, and ends on SIGTERM.
 */

const LOOPBACK = '127.0.0.1';

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
  const proxy = createModelProxy({ sessions, keys, version: runningVersion() });
  const server = createServer(proxy.handle);
  const before = Number(await readFile(files.port, 'utf8').catch(() => '0'));
  // The port it had may be taken by now: then any free one, and sessions started from now reach it there.
  const port = await listen(server, Number.isInteger(before) ? before : 0).catch(() => listen(server, 0));
  await writeFile(files.port, String(port));
  await writeFile(files.pid, String(process.pid));
  await new Promise<void>((resolve) => {
    process.once('SIGTERM', () => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
  });
  return 0;
}
