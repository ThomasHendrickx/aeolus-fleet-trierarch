import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claimFreePort, type PortClaims } from './port-claims.js';

// The ports the end-to-end tests serve on: full runs in other worktrees share
// the host, so no two runs may serve on one port (#686).

/** Linux's own first ephemeral port, where a listen on port 0 starts. */
const FIRST_EPHEMERAL_PORT = 32_768;

/** A range away from the default one, so a full run beside this test keeps its own. */
const FIRST_TEST_PORT = 31_000;

/** Ports each of two runs at once claims. */
const CLAIMS_PER_RUN = 10;

/**
 * The ports the two runs claim from: more than they ask for, since two runs that claim one port at once both give it up,
 * which keeps it unshared but leaves the pool a port short (#899).
 */
const POOL_FOR_TWO_RUNS = 3 * CLAIMS_PER_RUN;

/** Claims ports in this file's own child process: another test run, as a full run in another worktree is. */
const OTHER_RUN = `
const { claimFreePort } = await import(process.env.PORT_CLAIMS_MODULE);
const where = JSON.parse(process.env.PORT_CLAIMS);
const ports = [];
for (let index = 0; index < Number(process.env.CLAIMS); index += 1) {
  ports.push(await claimFreePort(where));
}
console.log(JSON.stringify(ports));
if (process.env.HOLD === 'yes') {
  setInterval(() => {}, 60_000);
}
`;

let claimsDirectory = '';
const otherRuns: ReturnType<typeof spawn>[] = [];
const listening: Server[] = [];

beforeEach(async () => {
  claimsDirectory = await mkdtemp(join(tmpdir(), 'port-claims-test-'));
});

afterEach(async () => {
  for (const run of otherRuns.splice(0)) {
    run.kill('SIGKILL');
  }
  for (const server of listening.splice(0)) {
    server.close();
  }
  await rm(claimsDirectory, { recursive: true, force: true });
});

function claimsOf(first: number, last: number): PortClaims {
  return { first, last, claimsDirectory };
}

/** Starts another run that claims ports; answers them once claimed, while that run lives on when held. */
async function otherRunClaims(where: PortClaims, options: { claims: number; isHeld: boolean }): Promise<number[]> {
  const run = spawn(process.execPath, ['--input-type=module', '--eval', OTHER_RUN], {
    env: {
      ...process.env,
      PORT_CLAIMS_MODULE: new URL('port-claims.ts', import.meta.url).href,
      PORT_CLAIMS: JSON.stringify(where),
      CLAIMS: String(options.claims),
      HOLD: options.isHeld ? 'yes' : 'no',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  otherRuns.push(run);
  // Listened for at once: a run that is not held may end before it is awaited.
  const exited = once(run, 'exit');
  let output = '';
  run.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  while (!output.includes('\n')) {
    if (run.exitCode !== null) {
      throw new Error(`the other run exited with ${String(run.exitCode)}:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!options.isHeld) {
    await exited;
  }
  const ports: unknown = JSON.parse(output);
  if (!Array.isArray(ports) || !ports.every((port) => typeof port === 'number')) {
    throw new Error(`the other run answered no ports:\n${output}`);
  }
  return ports;
}

async function listenOn(port: number): Promise<void> {
  const server = createServer();
  server.listen(port);
  await once(server, 'listening');
  listening.push(server);
}

describe('the ports the end-to-end tests serve on', () => {
  it('lie below the ephemeral range, where no listen on port 0 lands', async () => {
    const port = await claimFreePort();

    expect(port).toBeLessThan(FIRST_EPHEMERAL_PORT);
  });

  it('are never shared by two runs at once', async () => {
    const where = claimsOf(FIRST_TEST_PORT, FIRST_TEST_PORT + POOL_FOR_TWO_RUNS - 1);

    const [one, other] = await Promise.all([
      otherRunClaims(where, { claims: CLAIMS_PER_RUN, isHeld: true }),
      otherRunClaims(where, { claims: CLAIMS_PER_RUN, isHeld: true }),
    ]);

    expect(new Set([...one, ...other]).size).toBe(2 * CLAIMS_PER_RUN);
  });

  it('refuses a port another run that lives on claimed', async () => {
    const where = claimsOf(FIRST_TEST_PORT, FIRST_TEST_PORT);
    await otherRunClaims(where, { claims: 1, isHeld: true });

    await expect(claimFreePort(where)).rejects.toThrow('no free port');
  });

  it('claims a port again once the run that claimed it ended', async () => {
    const where = claimsOf(FIRST_TEST_PORT, FIRST_TEST_PORT);
    await otherRunClaims(where, { claims: 1, isHeld: false });

    expect(await claimFreePort(where)).toBe(FIRST_TEST_PORT);
  });

  it('refuses a port something listens on', async () => {
    const where = claimsOf(FIRST_TEST_PORT, FIRST_TEST_PORT);
    await listenOn(FIRST_TEST_PORT);

    await expect(claimFreePort(where)).rejects.toThrow('no free port');
  });
});
