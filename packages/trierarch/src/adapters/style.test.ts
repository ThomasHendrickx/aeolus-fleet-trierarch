import { stripVTControlCharacters } from 'node:util';

import { describe, expect, it } from 'vitest';

import { createStyle, isColourTerminal, PLAIN, stateTone } from './style.js';

describe('the terminal style', () => {
  it('colours a terminal only, never with NO_COLOR or a dumb terminal, and always with FORCE_COLOR', () => {
    expect(isColourTerminal({}, true)).toBe(true);
    expect(isColourTerminal({}, false)).toBe(false);
    expect(isColourTerminal({ NO_COLOR: '1' }, true)).toBe(false);
    expect(isColourTerminal({ TERM: 'dumb' }, true)).toBe(false);
    expect(isColourTerminal({ FORCE_COLOR: '1' }, false)).toBe(true);
    expect(isColourTerminal({ NO_COLOR: '' }, true)).toBe(true);
  });

  it('leaves text as it is without colour, and wraps the same text in colour with it', () => {
    const colour = createStyle({ isColour: true });

    expect(PLAIN.tone('bad', 'crashed')).toBe('crashed');
    expect(colour.tone('bad', 'crashed')).not.toBe('crashed');
    expect(stripVTControlCharacters(colour.tone('bad', 'crashed'))).toBe('crashed');
  });

  it('gives each entry state the tone of how it stands', () => {
    expect(stateTone('running')).toBe('good');
    expect(stateTone('crewing')).toBe('busy');
    expect(stateTone('restarting')).toBe('busy');
    expect(stateTone('crashed')).toBe('bad');
    expect(stateTone('releasing')).toBe('quiet');
  });
});
