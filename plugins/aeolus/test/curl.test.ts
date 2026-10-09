import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startStubFleet, type StubAnswer, type StubFleet } from './stub-fleet.js';

// The crew token never leaves the identity file except to the fleet (#445):
// it reaches curl without appearing on curl's command line, which any process
// of the same user can read (ps) while a call runs. A curl on PATH records the
// arguments its process gets, then runs the real curl.

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));
const CREW_TOKEN = 'aeolus_ct_v1_never_on_a_command_line';
const SECRET = 'aeolus_sk_v1_from_the_crew_line';
const SHIP_ID = 'shp_01m3tbfspe96yf1rnr4ank9h1a';
const REAL_CURL = spawnSync('bash', ['-c', 'command -v curl'], { encoding: 'utf8' }).stdout.trim();

let data: string;
let folder: string;
let bin: string;
let curlArguments: string;
let fleet: StubFleet | undefined;

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'aeolus-data-'));
  folder = mkdtempSync(join(tmpdir(), 'aeolus-folder-'));
  bin = join(data, 'bin');
  curlArguments = join(data, 'curl.arguments');
  mkdirSync(bin);
  const curl = join(bin, 'curl');
  writeFileSync(curl, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> '${curlArguments}'\nexec '${REAL_CURL}' "$@"\n`);
  chmodSync(curl, 0o700);
});

afterEach(async () => {
  await fleet?.close();
  fleet = undefined;
  rmSync(data, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
});

/** Runs a script as a session's command does, with the recording curl first on PATH. */
function run(script: string, args: string[] = []): Promise<number | null> {
  const child = spawn('bash', [join(SCRIPTS, script), ...args], {
    env: { ...process.env, AEOLUS_FOLDER: folder, AEOLUS_DATA: data, PATH: `${bin}:${process.env.PATH ?? ''}` },
  });
  child.stdin.end('');
  child.stdout.resume();
  child.stderr.resume();
  return new Promise((resolve) => {
    child.on('close', resolve);
  });
}

async function crewedAt(answers: readonly StubAnswer[]): Promise<StubFleet> {
  const started = await startStubFleet(answers);
  expect(await run('aeolus-identity.sh', ['write', started.url, SHIP_ID, 'scout', CREW_TOKEN])).toBe(0);
  return started;
}

/** Every argument the curl processes got: what ps shows while a call runs. */
function curlCommandLines(): string {
  return readFileSync(curlArguments, 'utf8');
}

const whoami = { status: 200, body: { shipId: SHIP_ID, fleetId: 'flt_01m3tbfspe96yf1rnr4ank9h1c', name: 'scout', type: 'implementer' } };

describe("the crew token stays off curl's command line", () => {
  it('aeolus-fleet sends the crew token as the bearer, and no curl argument holds it', async () => {
    fleet = await crewedAt([whoami]);

    expect(await run('aeolus-fleet.sh', ['whoami'])).toBe(0);

    expect(fleet.calls[0]?.authorization).toBe(`Bearer ${CREW_TOKEN}`);
    expect(curlCommandLines()).toContain('/api/v1/ship/whoami');
    expect(curlCommandLines()).not.toContain(CREW_TOKEN);
  });

  it('aeolus-fleet register asks whoami with the new crew token, and no curl argument holds it', async () => {
    fleet = await startStubFleet([{ status: 200, body: { crewToken: CREW_TOKEN } }, whoami]);

    expect(await run('aeolus-fleet.sh', ['register', fleet.url, SHIP_ID, SECRET, 'SERVER'])).toBe(0);

    expect(fleet.calls[1]?.authorization).toBe(`Bearer ${CREW_TOKEN}`);
    expect(curlCommandLines()).toContain('/api/v1/ship/whoami');
    expect(curlCommandLines()).not.toContain(CREW_TOKEN);
  });

  it('aeolus-inbox sends the crew token as the bearer, and no curl argument holds it', async () => {
    fleet = await crewedAt([{ status: 200, body: { waiting: 0 } }]);

    expect(await run('aeolus-inbox.sh')).toBe(0);

    expect(fleet.calls[0]?.authorization).toBe(`Bearer ${CREW_TOKEN}`);
    expect(curlCommandLines()).toContain('/api/v1/ship/inbox');
    expect(curlCommandLines()).not.toContain(CREW_TOKEN);
  });

  it('the watcher sends the crew token as the bearer, and no curl argument holds it', async () => {
    fleet = await crewedAt([{ status: 200, body: { waiting: 1 } }]);

    expect(await run('aeolus-wait.sh')).toBe(0);

    expect(fleet.calls[0]?.authorization).toBe(`Bearer ${CREW_TOKEN}`);
    expect(curlCommandLines()).toContain('/api/v1/ship/inbox');
    expect(curlCommandLines()).not.toContain(CREW_TOKEN);
  });
});
