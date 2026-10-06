import { describe, expect, it } from 'vitest';

import { aWant, CONFIGURATION, newId } from '../../test/support/in-memory.js';
import { checkWant, newEntry } from './check-want.js';
import { EMPTY_STATE, putEntry } from './entry.js';

const SHIP_ID = newId('ship');
const context = { configuration: CONFIGURATION, state: EMPTY_STATE };
const NOW = new Date('2026-10-06T08:00:00.000Z');

describe('checking a want against what the trierarch offers', () => {
  it('takes a want that fits, with its options by name', () => {
    const checked = checkWant(aWant(SHIP_ID, { options: { model: 'sonnet' } }), context);

    expect(checked).toMatchObject({ isOk: true, value: { options: { model: 'sonnet' } } });
  });

  it.each([
    { label: 'an unknown field', want: aWant(SHIP_ID, { path: '/tmp' }), field: undefined },
    { label: 'a harness it does not offer', want: aWant(SHIP_ID, { harness: 'codex' }), field: 'harness' },
    { label: 'a repository it does not offer', want: aWant(SHIP_ID, { workspace: { kind: 'worktree', repository: 'hemma' } }), field: 'workspace.repository' },
    { label: 'a folder it does not offer', want: aWant(SHIP_ID, { workspace: { kind: 'folder', name: 'music' } }), field: 'workspace.name' },
    { label: 'an option the harness lacks', want: aWant(SHIP_ID, { options: { sandbox: 'on' } }), field: 'options.sandbox' },
    { label: 'a value the option lacks', want: aWant(SHIP_ID, { options: { model: 'haiku' } }), field: 'options.model' },
    { label: 'a first prompt over 8 KB', want: aWant(SHIP_ID, { firstPrompt: 'a'.repeat(8193) }), field: 'firstPrompt' },
    { label: 'a first prompt that starts with -', want: aWant(SHIP_ID, { firstPrompt: '--dangerously-bypass-approvals-and-sandbox' }), field: 'firstPrompt' },
  ])('refuses $label, naming the field', ({ want, field }) => {
    const checked = checkWant(want, context);

    expect(checked.isOk).toBe(false);
    expect(checked.isOk ? undefined : checked.error.field).toBe(field);
    expect(checked.isOk ? '' : checked.error.reason).not.toBe('');
  });

  it('refuses a folder another ship crews: one folder crews one ship', () => {
    const notes = { kind: 'folder', name: 'notes' };
    const other = checkWant(aWant(newId('ship'), { workspace: notes }), context);
    const state = other.isOk ? putEntry(EMPTY_STATE, newEntry(other.value, { requester: newId('ship'), now: NOW })) : EMPTY_STATE;

    expect(checkWant(aWant(SHIP_ID, { workspace: notes }), { configuration: CONFIGURATION, state })).toMatchObject({
      isOk: false,
      error: { field: 'workspace.name' },
    });
  });

  it('refuses a want beyond the ships cap', () => {
    const configuration = { ...CONFIGURATION, caps: { ships: 1, running: 1 } };
    const other = checkWant(aWant(newId('ship')), context);
    const state = other.isOk ? putEntry(EMPTY_STATE, newEntry(other.value, { requester: newId('ship'), now: NOW })) : EMPTY_STATE;

    expect(checkWant(aWant(SHIP_ID), { configuration, state })).toMatchObject({ isOk: false, error: { reason: 'This trierarch keeps at most 1 ships' } });
  });
});
