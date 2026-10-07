import { styleText } from 'node:util';

import type { EntryState } from '../core/entry.js';

/**
 * How the command colours what it says: Node's own styleText, no colour
 * library. Colour only where a person reads a colour terminal; otherwise the
 * same words, plain. A tone names how a thing stands, not its colour.
 */
export type Tone = 'good' | 'busy' | 'bad' | 'quiet' | 'strong';

export interface Style {
  tone(tone: Tone, text: string): string;
}

const FORMATS: Readonly<Record<Tone, Parameters<typeof styleText>[0]>> = {
  good: 'green',
  busy: 'yellow',
  bad: 'red',
  quiet: 'dim',
  strong: 'bold',
};

/** A terminal that shows colour: NO_COLOR (https://no-color.org) and a dumb terminal turn it off, FORCE_COLOR on. */
export function isColourTerminal(env: Readonly<Record<string, string | undefined>>, isTerminal: boolean): boolean {
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') {
    return true;
  }
  if ((env.NO_COLOR !== undefined && env.NO_COLOR !== '') || env.TERM === 'dumb') {
    return false;
  }
  return isTerminal;
}

export const PLAIN: Style = { tone: (_tone, text) => text };

export function createStyle(at: { isColour: boolean }): Style {
  // The stream is decided above, by isColourTerminal: styleText is not to check it again.
  return at.isColour ? { tone: (tone, text) => styleText(FORMATS[tone], text, { validateStream: false }) } : PLAIN;
}

/** How an entry's state stands: running is good, on its way is busy, crashed is bad, releasing is quiet. */
export function stateTone(state: EntryState): Tone {
  switch (state) {
    case 'running':
      return 'good';
    case 'crewing':
    case 'restarting':
      return 'busy';
    case 'crashed':
      return 'bad';
    case 'releasing':
      return 'quiet';
  }
}
