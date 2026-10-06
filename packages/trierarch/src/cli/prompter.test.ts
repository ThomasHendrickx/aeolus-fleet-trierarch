import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTerminalPrompter, type TerminalPrompter } from './prompter.js';

let input: PassThrough;
let output: PassThrough;
let shown: string;
let prompter: TerminalPrompter;

beforeEach(() => {
  input = new PassThrough();
  output = new PassThrough();
  shown = '';
  output.on('data', (chunk: Buffer) => {
    shown += chunk.toString('utf8');
  });
  prompter = createTerminalPrompter({ input, output });
});

afterEach(() => {
  prompter.close();
});

describe('the terminal prompter', () => {
  it('asks a question and answers the line typed, or the default for an empty one', async () => {
    input.write('aeolus-fleet\n\n');

    await expect(prompter.text('Its name?')).resolves.toBe('aeolus-fleet');
    await expect(prompter.text('How many ships?', { default: '4' })).resolves.toBe('4');
    expect(shown).toContain('Its name? ');
    expect(shown).toContain('How many ships? (4) ');
  });

  it('answers yes or no, and the default for an empty line', async () => {
    input.write('y\nno\n\n\n');

    await expect(prompter.confirm('Install?', { isDefault: false })).resolves.toBe(true);
    await expect(prompter.confirm('Install?', { isDefault: true })).resolves.toBe(false);
    await expect(prompter.confirm('Install?', { isDefault: true })).resolves.toBe(true);
    await expect(prompter.confirm('Install?', { isDefault: false })).resolves.toBe(false);
    expect(shown).toContain('Install? [y/N] ');
    expect(shown).toContain('Install? [Y/n] ');
  });

  it('asks again for an answer that is neither yes nor no', async () => {
    input.write('maybe\nyes\n');

    await expect(prompter.confirm('Install?', { isDefault: false })).resolves.toBe(true);
    expect(shown).toContain('Answer y or n.');
  });

  it('never shows a secret as it is typed', async () => {
    input.write('aeolus_sk_v1_hidden\n');

    await expect(prompter.secret('Its secret?')).resolves.toBe('aeolus_sk_v1_hidden');
    expect(shown).toContain('Its secret? ');
    expect(shown).not.toContain('aeolus_sk_v1_hidden');
  });

  it('says a line', () => {
    prompter.say('Registered.');

    expect(shown).toBe('Registered.\n');
  });

  it('refuses to wait when the input ends before an answer', async () => {
    input.end();

    await expect(prompter.text('Its name?')).rejects.toThrow('The input ended before an answer to: Its name?');
  });
});
