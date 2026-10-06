import { z } from 'zod';

import { PLAIN, type Style } from './style.js';
import type { LoggedAction, Logger } from '../core/ports.js';

/**
 * The trierarch's log, `~/.aeolus/trierarch/logs/trierarch.log`: one JSON
 * object per line, an action the loop took for a ship or a message. JSON so
 * `aeolus-trierarch logs --json` passes the records on as they are, and
 * `logs` renders them for the operator. A run in a terminal writes the
 * rendered text instead. A line that is no record (an older line, a stack
 * trace) is read and shown as it is.
 */

const actionRecordSchema = z.strictObject({
  time: z.string(),
  shipId: z.string(),
  shipName: z.string().optional(),
  action: z.string(),
  outcome: z.string(),
  next: z.string().optional(),
});

const messageRecordSchema = z.strictObject({ time: z.string(), level: z.enum(['info', 'warn']), message: z.string() });

const logRecordSchema = z.union([actionRecordSchema, messageRecordSchema]);
export type LogRecord = z.infer<typeof logRecordSchema>;

/** A stream the log writes to, and whether a person reads it there. */
export interface LogStream {
  write(text: string): void;
  readonly isTerminal: boolean;
}

const FAILED = 'failed:';

/** A record as the operator reads it; where the style colours, the time quiet, the ship strong, a failure bad and what happens next busy. */
function render(record: LogRecord, style: Style = PLAIN): string {
  const time = style.tone('quiet', record.time);
  if ('level' in record) {
    return `${time} ${record.level === 'warn' ? style.tone('busy', record.level) : record.level} ${record.message}`;
  }
  const ship = style.tone('strong', record.shipName === undefined ? record.shipId : `${record.shipId} (${record.shipName})`);
  const outcome = record.outcome.startsWith(FAILED) ? style.tone('bad', record.outcome) : record.outcome;
  return `${time} ${ship} ${record.action}: ${outcome}${record.next === undefined ? '' : `. ${style.tone('busy', `Next: ${record.next}`)}`}`;
}

/** A line of the log as its record, or as it is when it is none. */
export function readLogLine(line: string): LogRecord | { line: string } {
  try {
    const record = logRecordSchema.safeParse(JSON.parse(line));
    return record.success ? record.data : { line };
  } catch {
    return { line };
  }
}

/** A line of the log as the operator reads it. */
export function renderLogLine(line: string, style: Style = PLAIN): string {
  const read = readLogLine(line);
  return 'line' in read ? read.line : render(read, style);
}

/** Info and actions to `out`, warnings to `err`; each a JSON line, or rendered text where a person reads it. */
export function createLogger(at: { out: LogStream; err: LogStream; now: () => Date }): Logger & { info(message: string): void } {
  const write = (stream: LogStream, record: LogRecord): void => {
    stream.write(`${stream.isTerminal ? render(record) : JSON.stringify(record)}\n`);
  };
  return {
    info: (message) => {
      write(at.out, { time: at.now().toISOString(), level: 'info', message });
    },
    warn: (message) => {
      write(at.err, { time: at.now().toISOString(), level: 'warn', message });
    },
    action: (logged: LoggedAction) => {
      const { time, ...rest } = logged;
      write(at.out, { time: time.toISOString(), ...rest });
    },
  };
}
