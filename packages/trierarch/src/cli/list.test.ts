import { stripVTControlCharacters } from 'node:util';

import { describe, expect, it } from 'vitest';

import { aTrierarch, aWant, NOTES_FOLDER, WORKTREE_ROOT } from '../../test/support/in-memory.js';
import { describeList, inspectList } from './list.js';
import { createStyle } from '../adapters/style.js';

describe('aeolus-trierarch list', () => {
  it('lists the wanted entries with ship, state, harness, workspace, folder, since and restarts', async () => {
    const trierarch = aTrierarch();
    const scout = trierarch.fleet.commission('scout');
    const notes = trierarch.fleet.commission('notes');
    await trierarch.command('want', aWant(scout, { workspace: { kind: 'worktree', repository: 'aeolus-fleet', ref: 'main' } }));
    await trierarch.command('want', aWant(notes, { workspace: { kind: 'folder', name: 'notes' } }));
    await trierarch.pass();
    trierarch.processes.exit(scout);
    await trierarch.pass();

    const entries = await inspectList(trierarch.state);

    expect(entries).toEqual([
      { shipId: scout, state: 'restarting', harness: 'claude-code', workspace: 'worktree aeolus-fleet at main', folder: `${WORKTREE_ROOT}/aeolus-fleet/scout`, since: '2026-10-06T08:00:00.000Z', restarts: 1 },
      { shipId: notes, state: 'running', harness: 'claude-code', workspace: 'folder notes', folder: NOTES_FOLDER, since: '2026-10-06T08:00:00.000Z', restarts: 0 },
    ]);
    expect(describeList(entries)).toBe(
      [
        'SHIP                            STATE       HARNESS      WORKSPACE                      SINCE                     RESTARTS',
        `${scout}  restarting  claude-code  worktree aeolus-fleet at main  2026-10-06T08:00:00.000Z  1`,
        `${notes}  running     claude-code  folder notes                   2026-10-06T08:00:00.000Z  0`,
      ].join('\n'),
    );
  });

  it('colours each state on a colour terminal, keeping the columns as they are in plain text', async () => {
    const trierarch = aTrierarch();
    const scout = trierarch.fleet.commission('scout');
    await trierarch.command('want', aWant(scout));
    await trierarch.pass();
    const entries = await inspectList(trierarch.state);

    const coloured = describeList(entries, createStyle({ isColour: true }));

    expect(coloured).not.toBe(describeList(entries));
    expect(stripVTControlCharacters(coloured)).toBe(describeList(entries));
  });

  it('says when no ship is on the list', async () => {
    expect(describeList(await inspectList(aTrierarch().state))).toBe('No ship is on the list.');
  });
});
