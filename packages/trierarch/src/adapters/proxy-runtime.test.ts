import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TRIERARCH_PROGRAM } from '../../test/support/hold-program.js';
import { aShortHome } from '../../test/support/short-home.js';
import { createProxyRuntime, type ProxyRuntime } from './proxy-runtime.js';
import { runningVersion } from './version.js';

// Against the real proxy: the trierarch program from source, started as the
// trierarch starts it.

const VERSION = runningVersion();

let home: string;
let runtimes: ProxyRuntime[];
let children: ChildProcess[];

beforeEach(() => {
  home = realpathSync(aShortHome('aeolus-proxy'));
  runtimes = [];
  children = [];
});

afterEach(async () => {
  for (const runtime of runtimes) {
    await runtime.keep({ isNeeded: false });
  }
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit');
      child.kill('SIGKILL');
      await ended;
    }
  }
  rmSync(home, { recursive: true, force: true });
});

function aRuntime(version = VERSION): ProxyRuntime {
  const runtime = createProxyRuntime({ folder: join(home, 'proxy'), sessions: join(home, 'sessions'), keys: join(home, 'keys'), program: TRIERARCH_PROGRAM, version });
  runtimes.push(runtime);
  return runtime;
}

const pidOf = (): number => Number(readFileSync(join(home, 'proxy', 'proxy.pid'), 'utf8'));

async function aProcess(words: readonly string[], onTerm = ''): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', `${onTerm}; setInterval(() => undefined, 1000); process.stdout.write('ready');`, '--', ...words], { stdio: ['ignore', 'pipe', 'ignore'] });
  children.push(child);
  await once(child.stdout, 'data');
  return child;
}

function recordPid(child: ChildProcess): void {
  const folder = join(home, 'proxy');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'proxy.pid'), String(child.pid));
}

async function stateAt(url: string | undefined): Promise<unknown> {
  const answer = await fetch(`${url ?? ''}/aeolus/state`).catch(() => undefined);
  return answer?.ok === true ? answer.json() : undefined;
}

describe('the model proxy process (headless H16)', () => {
  it.each(['unrelated', 'another folder', 'a folder with the same prefix', 'another command'])('leaves %s running when a stale pid file names it', async (kind) => {
    const folder = join(home, 'proxy');
    const words = kind === 'unrelated' ? [] : [kind === 'another command' ? 'not-proxy' : 'proxy', '--folder', kind === 'another folder' ? join(home, 'another') : kind === 'a folder with the same prefix' ? `${folder}-other` : folder];
    const child = await aProcess(words);
    recordPid(child);

    await aRuntime().keep({ isNeeded: false });

    expect(child.signalCode).toBeNull();
    expect(child.exitCode).toBeNull();
    expect(existsSync(join(folder, 'proxy.pid'))).toBe(false);
  });

  it('checks that the process still belongs to this proxy before escalating to SIGKILL', async () => {
    const child = await aProcess(['proxy', '--folder', join(home, 'proxy')], 'process.on("SIGTERM", () => { process.title = "unrelated"; })');
    recordPid(child);

    await aRuntime().keep({ isNeeded: false });
    // Let the child exit event arrive if stop sent SIGKILL just before returning.
    await wait(200);

    expect(child.signalCode).toBeNull();
    expect(child.exitCode).toBeNull();
  });

  it('starts a needed proxy without stopping an unrelated process named by a stale pid file', async () => {
    const child = await aProcess([]);
    recordPid(child);
    const runtime = aRuntime();

    await runtime.keep({ isNeeded: true });

    expect(child.signalCode).toBeNull();
    expect(child.exitCode).toBeNull();
    await expect(stateAt(await runtime.url())).resolves.toEqual({ version: VERSION });
  });

  it('kills a proxy that still belongs to this folder after ignoring SIGTERM', async () => {
    const child = await aProcess(['proxy', '--folder', join(home, 'proxy')], 'process.on("SIGTERM", () => undefined)');
    recordPid(child);

    await aRuntime().keep({ isNeeded: false });

    await expect.poll(() => child.signalCode).toBe('SIGKILL');
  });

  it('starts while it is needed, on loopback, and answers its version at the address it gives', async () => {
    const runtime = aRuntime();

    await runtime.keep({ isNeeded: true });

    const url = await runtime.url();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    await expect(stateAt(url)).resolves.toEqual({ version: VERSION });
  });

  // Linux gives a port-0 listener or an outbound connection a port from 32768 (ip_local_port_range), macOS from 49152:
  // a port in that range, freed while the proxy is gone, can be taken before it listens again.
  it('listens below the ephemeral port ranges, so no outbound connection or other listener is given its port while it is gone', async () => {
    const runtime = aRuntime();

    await runtime.keep({ isNeeded: true });

    const port = Number(new URL((await runtime.url()) ?? 'http://127.0.0.1:0').port);
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(port).toBeLessThan(32_768);
  });

  it('leaves a running proxy of its version alone', async () => {
    const runtime = aRuntime();
    await runtime.keep({ isNeeded: true });
    const first = pidOf();

    await runtime.keep({ isNeeded: true });

    expect(pidOf()).toBe(first);
  });

  it('starts a proxy that is gone again, on the same address, so running sessions reach it where they did', async () => {
    const runtime = aRuntime();
    await runtime.keep({ isNeeded: true });
    const url = await runtime.url();
    process.kill(pidOf(), 'SIGKILL');
    await expect.poll(() => stateAt(url)).toBeUndefined();

    await runtime.keep({ isNeeded: true });

    expect(await runtime.url()).toBe(url);
    await expect(stateAt(url)).resolves.toEqual({ version: VERSION });
  });

  it('stops the proxy once no harness needs it', async () => {
    const runtime = aRuntime();
    await runtime.keep({ isNeeded: true });
    const url = await runtime.url();

    await runtime.keep({ isNeeded: false });

    await expect(stateAt(url)).resolves.toBeUndefined();
  });

  it('replaces a proxy another version started', async () => {
    await aRuntime().keep({ isNeeded: true });
    const first = pidOf();

    await aRuntime('0.0.1-older').keep({ isNeeded: true });

    expect(pidOf()).not.toBe(first);
  });
});
