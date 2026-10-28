import { readFile, writeFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';

import { z } from 'zod';

import { loadConfiguration, TrierarchFileError, type RunningFile } from '../adapters/files.js';
import type { KeyFiles } from '../adapters/key-files.js';
import { PLUGIN_HARNESSES, type PluginHarness } from '../adapters/plugin.js';
import type { Service } from '../adapters/service.js';
import type { KeyCheck } from '../adapters/vendor-key-check.js';
import type { KeyStateAt, Login as SessionLogin, Logins } from '../core/login.js';
import { NOT_SAID_YET, startNewProcess } from './new-process.js';

/**
 * `aeolus-trierarch login` (api keys K11): keeps a harness's API key on this
 * computer, chooses which login each harness and ship runs on, and says them.
 * A key comes in on stdin, never a flag, so it stays out of the shell history
 * (#445); it is written only once its vendor takes it, and never said back
 * (K7). The logins go in the configuration (K5), every other key of it kept as
 * written. Every change restarts the service, as `add` does; sessions keep
 * running, each on the login it started with (K3).
 */

export type LoginRequest =
  | { readonly kind: 'show' }
  | { readonly kind: 'apiKey'; readonly harness: PluginHarness }
  | { readonly kind: 'removeKey'; readonly harness: PluginHarness }
  | { readonly kind: 'check'; readonly harness: PluginHarness }
  | { readonly kind: 'setDefault'; readonly harness: PluginHarness; readonly login: SessionLogin }
  | { readonly kind: 'setShip'; readonly shipName: string; readonly login: SessionLogin | 'default' };

/** The key's state as login knows it: a key is written only once its vendor took it (K8). */
export type KeyState = 'none' | 'ready';

export interface HarnessLogin {
  readonly harness: PluginHarness;
  /** A harness with no default in the configuration runs on its subscription (K5). */
  readonly default: SessionLogin;
  readonly key: KeyState;
}

/** A ship the configuration names, on its own login. */
export interface ShipLogin {
  readonly shipName: string;
  readonly login: SessionLogin;
}

export interface LoginReport {
  readonly harnesses: readonly HarnessLogin[];
  readonly ships: readonly ShipLogin[];
  readonly said: readonly string[];
}

export interface Login {
  readonly request: LoginRequest;
  /** The configuration's file. */
  readonly config: string;
  readonly keys: KeyFiles;
  /** The key, as the operator types it at a terminal or pipes it in. */
  readonly readKey: () => Promise<string>;
  readonly check: (harness: PluginHarness, key: string) => Promise<KeyCheck>;
  readonly service: Pick<Service, 'status' | 'restart'>;
  readonly running: () => Promise<RunningFile | undefined>;
  /** Waits between reads of running.json; a test passes one that does not wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Has the model proxy check the harness's key at once (K10): its state after; none when the proxy does not run. */
  readonly checkNow: (harness: PluginHarness) => Promise<KeyStateAt | undefined>;
}

const HARNESS_NAMES: Readonly<Record<PluginHarness, string>> = { 'claude-code': 'Claude Code', codex: 'Codex' };
const LOGIN_NAMES: Readonly<Record<SessionLogin, string>> = { apiKey: 'API key', subscription: 'Subscription' };
const LOGIN_WIDTH = Math.max(...Object.values(LOGIN_NAMES).map((name) => name.length));

/** The configuration as written: its logins read, every other key kept as it is. */
const rawSchema = z.object({ logins: z.object({ default: z.record(z.string(), z.string()).optional(), ships: z.record(z.string(), z.string()).optional() }).optional() }).loose();

export async function login(at: Login): Promise<LoginReport> {
  const said = await change(at);
  // Before init there is no configuration: every harness then runs on its subscription.
  const logins: Logins = (await loadConfiguration(at.config).catch(() => undefined))?.logins ?? {};
  const harnesses = await Promise.all(PLUGIN_HARNESSES.map(async (harness): Promise<HarnessLogin> => ({ harness, default: logins.default?.[harness] ?? 'subscription', key: (await at.keys.has(harness)) ? 'ready' : 'none' })));
  const ships = Object.entries(logins.ships ?? {})
    .map(([shipName, shipLogin]) => ({ shipName, login: shipLogin }))
    .sort((left, right) => left.shipName.localeCompare(right.shipName));
  if (at.request.kind === 'show') {
    const width = Math.max(...Object.values(HARNESS_NAMES).map((name) => name.length), ...ships.map((ship) => ship.shipName.length));
    const lines = [
      ...harnesses.map((harness) => `${HARNESS_NAMES[harness.harness].padEnd(width)}  default ${LOGIN_NAMES[harness.default].padEnd(LOGIN_WIDTH)}  ${harness.key === 'ready' ? 'API key ready' : 'no API key'}`),
      ...ships.map((ship) => `${ship.shipName.padEnd(width)}  ${LOGIN_NAMES[ship.login]}`),
    ];
    return { harnesses, ships, said: lines };
  }
  return { harnesses, ships, said };
}

/** Writes the logins into the configuration, every other key kept; answers whether that changed them. */
async function writeLogins(config: string, next: (logins: z.infer<typeof rawSchema>['logins']) => NonNullable<z.infer<typeof rawSchema>['logins']>): Promise<boolean> {
  // Checked as the trierarch reads it, so a broken configuration is said, never written over.
  await loadConfiguration(config);
  const raw = rawSchema.parse(JSON.parse(await readFile(config, 'utf8')));
  const logins = next(raw.logins);
  if (JSON.stringify(logins) === JSON.stringify(raw.logins ?? {})) {
    return false;
  }
  await writeFile(config, `${JSON.stringify({ ...raw, logins }, null, 2)}\n`);
  return true;
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
    case 'check': {
      const name = HARNESS_NAMES[request.harness];
      const key = await at.checkNow(request.harness);
      if (key === undefined) {
        throw new TrierarchFileError('The model proxy does not run: it runs while the service does and a harness holds a key (aeolus-trierarch start).');
      }
      switch (key.state) {
        case 'ready':
          return [`${name}'s API key is ready: its waiting ships start within a pass.`];
        case 'outOfCredit':
          return [`${name}'s API key is still out of credit since ${key.at ?? ''}. The proxy checks it again every 15 minutes.`];
        case 'refused':
          return [`${name}'s API key was refused by its vendor: give it a new one with aeolus-trierarch login ${request.harness} --api-key.`];
        case 'none':
          return [`${name} holds no API key: aeolus-trierarch login ${request.harness} --api-key.`];
      }
      break;
    }
    case 'setDefault': {
      const name = HARNESS_NAMES[request.harness];
      const label = LOGIN_NAMES[request.login];
      const isChanged = await writeLogins(at.config, (logins = {}) => ({ ...logins, default: { ...logins.default, [request.harness]: request.login } }));
      return isChanged ? [`${name} runs on ${label} by default, from each session's next start.`, ...(await restart(at))] : [`${name} runs on ${label} by default already.`];
    }
    case 'setShip': {
      const { shipName } = request;
      const label = request.login === 'default' ? "its harness's default" : LOGIN_NAMES[request.login];
      const isChanged = await writeLogins(at.config, (logins = {}) => {
        const others = Object.fromEntries(Object.entries(logins.ships ?? {}).filter(([name]) => name !== shipName));
        return { ...logins, ships: request.login === 'default' ? others : { ...others, [shipName]: request.login } };
      });
      return isChanged ? [`${shipName} runs on ${label} from its next start.`, ...(await restart(at))] : [`${shipName} runs on ${label} already.`];
    }
  }
}

async function restart(at: Login): Promise<string[]> {
  if (!(await at.service.status()).isInstalled) {
    return ['The service is not installed: run aeolus-trierarch install to run it.'];
  }
  const { hasSaidVersion } = await startNewProcess({ start: () => at.service.restart(), service: at.service, running: at.running, ...(at.sleep !== undefined && { sleep: at.sleep }) });
  return ['The trierarch restarted; its sessions kept running.', ...(hasSaidVersion ? [] : [NOT_SAID_YET])];
}

/** A key piped in: all of the input, without its line end. */
export async function readKeyFrom(input: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}
