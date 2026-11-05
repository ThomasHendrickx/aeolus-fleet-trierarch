import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { aMachine, type Machine } from './support/machine.js';

// `aeolus-trierarch logs`: the last lines of the trierarch's log, which on Linux is the journal of its systemd user unit (docs/trierarch.md, "Logs"), and with --follow each line written after (#177).

const FOLLOWED_WITHIN_MS = 15_000;
/** A follower starts reading after it printed the last lines: lines written in that moment are not followed. */
const FOLLOWER_STARTS_MS = 2_000;
const JOURNAL = 'journalctl --user --unit aeolus-trierarch.service';
const SHIP = 'shp_01m6n75scq9v1tqcttft530g8t';

let machine: Machine;

beforeEach(async () => {
  machine = await aMachine();
});

afterEach(async () => {
  await machine.remove();
});

const journal = () => join(machine.machine, 'systemd', 'trierarch.log');
const written = (lines: readonly string[]): void => {
  mkdirSync(join(machine.machine, 'systemd'), { recursive: true });
  writeFileSync(journal(), lines.map((line) => `${line}\n`).join(''));
};
const action = { time: '2026-10-06T15:00:00.000Z', shipId: SHIP, shipName: 'scout', action: 'crew', outcome: 'crewed, claude-code started in /worktrees/aeolus-fleet/scout' };
const failure = { time: '2026-10-06T15:00:05.000Z', shipId: SHIP, action: 'crew', outcome: 'failed: the fleet cannot be reached', next: 'the next pass tries again' };
const message = { time: '2026-10-06T15:00:10.000Z', level: 'warn', message: 'The loop failed and goes on: the fleet cannot be reached' };
const records = [action, failure, message].map((record) => JSON.stringify(record));

async function until(read: () => string, wanted: string): Promise<void> {
  const deadline = Date.now() + FOLLOWED_WITHIN_MS;
  while (!read().includes(wanted) && Date.now() < deadline) {
    await wait(100);
  }
  expect(read()).toContain(wanted);
}

describe('logs', () => {
  it('renders the records of the log for the operator, and a line that is no record as it is', async () => {
    written([...records, 'an older line']);

    const ran = await machine.trierarch(['logs']);

    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.stdout.split('\n')).toEqual([
      `2026-10-06T15:00:00.000Z ${SHIP} (scout) crew: crewed, claude-code started in /worktrees/aeolus-fleet/scout`,
      `2026-10-06T15:00:05.000Z ${SHIP} crew: failed: the fleet cannot be reached. Next: the next pass tries again`,
      '2026-10-06T15:00:10.000Z warn The loop failed and goes on: the fleet cannot be reached',
      'an older line',
      '',
    ]);
  });

  it('gives the journal and the records with --json, a line that is no record as { line }', async () => {
    written([...records, 'an older line']);

    const ran = await machine.trierarch(['logs', '--json']);

    expect(ran.status, ran.stderr).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual({ journal: JOURNAL, lines: [action, failure, message, { line: 'an older line' }] });
  });

  it('shows the last 50 lines, or the last --lines', async () => {
    written(Array.from({ length: 60 }, (_, index) => `line ${String(index + 1)}`));

    const byDefault = await machine.trierarch(['logs']);
    const few = await machine.trierarch(['logs', '--lines', '2']);
    const inline = await machine.trierarch(['logs', '--lines=1']);

    expect(byDefault.stdout.split('\n').filter((line) => line !== '')).toEqual(Array.from({ length: 50 }, (_, index) => `line ${String(index + 11)}`));
    expect(few.stdout).toBe('line 59\nline 60\n');
    expect(inline.stdout).toBe('line 60\n');
  });

  it('says so when the log holds no line yet', async () => {
    const ran = await machine.trierarch(['logs']);

    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe(`No log lines yet in the journal (${JOURNAL}).\n`);
  });

  it('refuses a --lines that is no whole number, as text and as JSON', async () => {
    for (const lines of ['many', '2.5', '-1']) {
      const ran = await machine.trierarch(['logs', '--lines', lines]);
      const json = await machine.trierarch(['logs', '--lines', lines, '--json']);

      expect(ran.status).toBe(1);
      expect(ran.stdout).toBe('--lines takes a whole number\n');
      expect(json.status).toBe(1);
      expect(JSON.parse(json.stdout)).toEqual({ error: '--lines takes a whole number' });
    }
  });

  it('with --follow shows the last lines, then each line written after, until it is stopped', async () => {
    written([...records, 'an older line']);

    const following = machine.start(['logs', '--follow', '--lines', '2']);
    await until(following.stdout, 'an older line\n');
    await wait(FOLLOWER_STARTS_MS);
    appendFileSync(journal(), `${JSON.stringify({ ...message, message: 'a later record' })}\nplain later line\n`);
    await until(following.stdout, 'plain later line\n');
    const status = await following.interrupt();

    expect(following.stdout().split('\n')).toEqual([
      '2026-10-06T15:00:10.000Z warn The loop failed and goes on: the fleet cannot be reached',
      'an older line',
      '2026-10-06T15:00:10.000Z warn a later record',
      'plain later line',
      '',
    ]);
    expect(status).toBe(0);
  });

  it('with --follow and --json writes each line as one JSON object', async () => {
    written([JSON.stringify(action)]);

    const following = machine.start(['logs', '--follow', '--json']);
    await until(following.stdout, '"crew"');
    await wait(FOLLOWER_STARTS_MS);
    appendFileSync(journal(), 'plain later line\n');
    await until(following.stdout, 'plain later line');
    await following.interrupt();

    expect(following.stdout().split('\n')).toEqual([JSON.stringify(action), JSON.stringify({ line: 'plain later line' }), '']);
  });
});
