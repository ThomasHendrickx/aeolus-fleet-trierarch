import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TRIERARCH_PROGRAM } from '../../test/support/hold-program.js';
import { createProxyRuntime, type ProxyRuntime } from './proxy-runtime.js';
import { runningVersion } from './version.js';

// Against the real proxy: the trierarch program from source, started as the
// trierarch starts it.

const VERSION = runningVersion();

let home: string;
let runtimes: ProxyRuntime[];

beforeEach(() => {
  home = realpathSync(mkdtempSync('/tmp/aeolus-proxy-'));
  runtimes = [];
});

afterEach(async () => {
  for (const runtime of runtimes) {
    await runtime.keep({ isNeeded: false });
  }
  rmSync(home, { recursive: true, force: true });
});

function aRuntime(version = VERSION): ProxyRuntime {
  const runtime = createProxyRuntime({ folder: join(home, 'proxy'), sessions: join(home, 'sessions'), keys: join(home, 'keys'), program: TRIERARCH_PROGRAM, version });
  runtimes.push(runtime);
  return runtime;
}

const pidOf = (): number => Number(readFileSync(join(home, 'proxy', 'proxy.pid'), 'utf8'));

async function stateAt(url: string | undefined): Promise<unknown> {
  const answer = await fetch(`${url ?? ''}/aeolus/state`).catch(() => undefined);
  return answer?.ok === true ? answer.json() : undefined;
}

describe('the model proxy process (headless H16)', () => {
  it('starts while it is needed, on loopback, and answers its version at the address it gives', async () => {
    const runtime = aRuntime();

    await runtime.keep({ isNeeded: true });

    const url = await runtime.url();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    await expect(stateAt(url)).resolves.toEqual({ version: VERSION });
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
