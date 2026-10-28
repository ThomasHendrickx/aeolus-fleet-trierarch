import type { Readable } from 'node:stream';

import { TrierarchFileError, type RunningFile } from '../adapters/files.js';
import type { KeyFiles } from '../adapters/key-files.js';
import { PLUGIN_HARNESSES, type PluginHarness } from '../adapters/plugin.js';
import type { Service } from '../adapters/service.js';
import type { KeyCheck } from '../adapters/vendor-key-check.js';
import { NOT_SAID_YET, startNewProcess } from './new-process.js';

/**
 * `aeolus-trierarch login` (api keys K11): keeps a harness's API key on this
 * computer, and says each harness's login. A key comes in on stdin, never a
 * flag, so it stays out of the shell history (#445); it is written only once
 * its vendor takes it, and never said back (K7). Every change restarts the
 * service, as `add` does; sessions keep running.
 */

export type LoginRequest = { readonly kind: 'show' } | { readonly kind: 'apiKey'; readonly harness: PluginHarness } | { readonly kind: 'removeKey'; readonly harness: PluginHarness };

/** The key's state as login knows it: a key is written only once its vendor took it (K8). */
export type KeyState = 'none' | 'ready';

export interface HarnessLogin {
  readonly harness: PluginHarness;
  /** A harness with no default in the configuration runs on its subscription (K5). */
  readonly default: 'subscription';
  readonly key: KeyState;
}

export interface LoginReport {
  readonly harnesses: readonly HarnessLogin[];
  readonly said: readonly string[];
}

export interface Login {
  readonly request: LoginRequest;
  readonly keys: KeyFiles;
  /** The key, as the operator types it at a terminal or pipes it in. */
  readonly readKey: () => Promise<string>;
  readonly check: (harness: PluginHarness, key: string) => Promise<KeyCheck>;
  readonly service: Pick<Service, 'status' | 'restart'>;
  readonly running: () => Promise<RunningFile | undefined>;
  /** Waits between reads of running.json; a test passes one that does not wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const HARNESS_NAMES: Readonly<Record<PluginHarness, string>> = { 'claude-code': 'Claude Code', codex: 'Codex' };
const NAME_WIDTH = Math.max(...Object.values(HARNESS_NAMES).map((name) => name.length));

export async function login(at: Login): Promise<LoginReport> {
  const said = await change(at);
  const harnesses = await Promise.all(PLUGIN_HARNESSES.map(async (harness): Promise<HarnessLogin> => ({ harness, default: 'subscription', key: (await at.keys.has(harness)) ? 'ready' : 'none' })));
  if (at.request.kind === 'show') {
    return { harnesses, said: harnesses.map(describe) };
  }
  return { harnesses, said };
}

/** What the request changes and what it says of it; nothing for show. */
async function change(at: Login): Promise<string[]> {
  const { request, keys } = at;
  switch (request.kind) {
    case 'show':
      return [];
    case 'apiKey': {
      const key = (await at.readKey()).trim();
      if (key === '') {
        throw new TrierarchFileError('No API key came in: pipe it in, or type it when asked.');
      }
      const checked = await at.check(request.harness, key);
      if (checked.kind !== 'taken') {
        throw new TrierarchFileError(`${checked.cause}. Nothing was written.`);
      }
      await keys.write(request.harness, key);
      return [`The vendor took the API key for ${HARNESS_NAMES[request.harness]}; it is kept on this computer only.`, ...(await restart(at))];
    }
    case 'removeKey':
      if (!(await keys.remove(request.harness))) {
        return [`${HARNESS_NAMES[request.harness]} holds no API key: nothing to remove.`];
      }
      return [`Removed the API key for ${HARNESS_NAMES[request.harness]}.`, ...(await restart(at))];
  }
}

async function restart(at: Login): Promise<string[]> {
  if (!(await at.service.status()).isInstalled) {
    return ['The service is not installed: run aeolus-trierarch install to run it.'];
  }
  const { hasSaidVersion } = await startNewProcess({ start: () => at.service.restart(), service: at.service, running: at.running, ...(at.sleep !== undefined && { sleep: at.sleep }) });
  return ['The trierarch restarted; its sessions kept running.', ...(hasSaidVersion ? [] : [NOT_SAID_YET])];
}

function describe(login: HarnessLogin): string {
  return `${HARNESS_NAMES[login.harness].padEnd(NAME_WIDTH)}  default Subscription  ${login.key === 'ready' ? 'API key ready' : 'no API key'}`;
}

/** A key piped in: all of the input, without its line end. */
export async function readKeyFrom(input: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}
