import { stripVTControlCharacters } from 'node:util';

import { describe, expect, it } from 'vitest';

import { newId } from '../../test/support/in-memory.js';
import { createStyle } from '../cli/style.js';
import { createLogger, readLogLine, renderLogLine } from './log.js';

const NOW = new Date('2026-10-06T15:00:00.000Z');
const shipId = newId('ship');
const crewed = { time: NOW, shipId, shipName: 'scout', action: 'crew', outcome: 'crewed, claude-code started in /worktrees/aeolus-fleet/scout' } as const;
const failed = { time: NOW, shipId, action: 'crew', outcome: 'failed: the fleet cannot be reached', next: 'the next pass tries again' } as const;

const parsed = (line: string): unknown => JSON.parse(line);

/** A logger writing to two collected streams, a terminal or not. */
function aLogger(isTerminal = false) {
  const out: string[] = [];
  const err: string[] = [];
  const logger = createLogger({ out: { write: (text) => out.push(text), isTerminal }, err: { write: (text) => err.push(text), isTerminal }, now: () => NOW });
  return { logger, out, err };
}

describe("the trierarch's log", () => {
  it('writes an action as one JSON line with its time, ship, action, outcome and what happens next', () => {
    const { logger, out } = aLogger();

    logger.action(crewed);
    logger.action(failed);

    expect(out.map((line) => parsed(line))).toEqual([
      { time: '2026-10-06T15:00:00.000Z', shipId, shipName: 'scout', action: 'crew', outcome: 'crewed, claude-code started in /worktrees/aeolus-fleet/scout' },
      { time: '2026-10-06T15:00:00.000Z', shipId, action: 'crew', outcome: 'failed: the fleet cannot be reached', next: 'the next pass tries again' },
    ]);
    expect(out.every((line) => line.endsWith('\n') && !line.slice(0, -1).includes('\n'))).toBe(true);
  });

  it('writes a message as one JSON line with its time and level, a warning to stderr', () => {
    const { logger, out, err } = aLogger();

    logger.info('aeolus-trierarch 0.18.0 runs');
    logger.warn('The loop failed and goes on: the fleet cannot be reached');

    expect(out.map((line) => parsed(line))).toEqual([{ time: '2026-10-06T15:00:00.000Z', level: 'info', message: 'aeolus-trierarch 0.18.0 runs' }]);
    expect(err.map((line) => parsed(line))).toEqual([{ time: '2026-10-06T15:00:00.000Z', level: 'warn', message: 'The loop failed and goes on: the fleet cannot be reached' }]);
  });

  it('writes readable text instead to a terminal, as a run in the foreground', () => {
    const { logger, out } = aLogger(true);

    logger.action(failed);

    expect(out).toEqual([`2026-10-06T15:00:00.000Z ${shipId} crew: failed: the fleet cannot be reached. Next: the next pass tries again\n`]);
  });

  it('renders each line for the operator: time, ship and its name, action and outcome, or the level and message', () => {
    const { logger, out, err } = aLogger();
    logger.action(crewed);
    logger.warn('The loop failed and goes on');

    expect([...out, ...err].map((line) => renderLogLine(line.trimEnd()))).toEqual([
      `2026-10-06T15:00:00.000Z ${shipId} (scout) crew: crewed, claude-code started in /worktrees/aeolus-fleet/scout`,
      '2026-10-06T15:00:00.000Z warn The loop failed and goes on',
    ]);
  });

  it('colours a line on a colour terminal, saying the same as in plain text', () => {
    const { logger, out } = aLogger();
    logger.action(failed);
    const line = (out[0] ?? '').trimEnd();

    const coloured = renderLogLine(line, createStyle({ isColour: true }));

    expect(coloured).not.toBe(renderLogLine(line));
    expect(stripVTControlCharacters(coloured)).toBe(renderLogLine(line));
  });

  it('reads a line that is no record, such as an older line or a stack trace, as it is', () => {
    expect(readLogLine('    at main (file:///aeolus-trierarch.js:1:1)')).toEqual({ line: '    at main (file:///aeolus-trierarch.js:1:1)' });
    expect(readLogLine('{"time":"not a record"}')).toEqual({ line: '{"time":"not a record"}' });
    expect(renderLogLine('2026-10-05T09:14:00.000Z The loop failed and goes on')).toBe('2026-10-05T09:14:00.000Z The loop failed and goes on');
  });
});
