import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recordingEnvironment, recordingPath, type RecordingPath } from './command-lines.js';
import { scriptEnvironment } from './script-environment.js';
import { startStubFleet, type StubFleet } from './stub-fleet.js';

// The crew token never travels on a command line (#822): any local user reads
// one in /proc/<pid>/cmdline while its process runs. Every program the
// scripts start runs through a recording PATH, which writes down its command
// line.

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));
const CREW_TOKEN = 'aeolus_ct_v1_never_on_a_command_line';
const SECRET = 'aeolus_sk_v1_from_the_crew_line';
const SHIP_ID = 'shp_01m3tbfspe96yf1rnr4ank9h1a';

let data: string;
let folder: string;
/** A throwaway home: the identities live under it, never in the real one. */
let home: string;
let recording: RecordingPath;
let fleet: StubFleet | undefined;

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'aeolus-data-'));
  home = mkdtempSync(join(tmpdir(), 'aeolus-home-'));
  folder = mkdtempSync(join(tmpdir(), 'aeolus-folder-'));
  recording = recordingPath(data);
});

afterEach(async () => {
  await fleet?.close();
  fleet = undefined;
  rmSync(data, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
});

/** Runs a script as a session's command does, through the recording PATH. */
function run(script: string, options: { args?: string[]; stdin?: string } = {}): Promise<{ status: number | null; stdout: string }> {
  const child = spawn('bash', [join(SCRIPTS, script), ...(options.args ?? [])], {
    env: scriptEnvironment({ HOME: home, AEOLUS_FOLDER: folder, AEOLUS_DATA: data, ...recordingEnvironment(recording) }),
  });
  child.stdin.end(options.stdin ?? '');
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.resume();
  return new Promise((resolve) => {
    child.on('close', (status) => {
      resolve({ status, stdout });
    });
  });
}

const whoami = { status: 200, body: { shipId: SHIP_ID, fleetId: 'flt_01m3tbfspe96yf1rnr4ank9h1c', name: 'scout', type: 'implementer' } };

describe('the crew token stays off every command line (#822)', () => {
  it('aeolus-identity.sh write takes the crew token on stdin and keeps it in the identity file', async () => {
    fleet = await startStubFleet([whoami]);

    expect((await run('aeolus-identity.sh', { args: ['write', fleet.url, SHIP_ID, 'scout'], stdin: `${CREW_TOKEN}\n` })).status).toBe(0);

    expect((await run('aeolus-fleet.sh', { args: ['whoami'] })).status).toBe(0);
    expect(fleet.calls[0]?.authorization).toBe(`Bearer ${CREW_TOKEN}`);
  });

  it('aeolus-identity.sh write refuses an empty crew token on stdin', async () => {
    expect((await run('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', SHIP_ID, 'scout'], stdin: '' })).status).toBe(2);

    expect((await run('aeolus-identity.sh', { args: ['show'] })).status).toBe(1);
  });

  it('aeolus-fleet register keeps the new crew token in the identity file, and no program it starts holds it on its command line', async () => {
    fleet = await startStubFleet([{ status: 200, body: { crewToken: CREW_TOKEN } }, whoami]);

    expect((await run('aeolus-fleet.sh', { args: ['register', fleet.url, SHIP_ID, SECRET, 'SERVER'] })).status).toBe(0);

    expect(recording.commandLines()).toContain('aeolus-identity.sh write');
    expect(recording.commandLines()).not.toContain(CREW_TOKEN);
    expect((await run('aeolus-identity.sh', { args: ['show'] })).stdout).toContain(`ship: scout (${SHIP_ID})`);
  });
});
