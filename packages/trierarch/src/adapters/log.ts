import { z } from 'zod';

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

function render(record: LogRecord): string {
  if ('level' in record) {
    return `${record.time} ${record.level} ${record.message}`;
  }
  const ship = record.shipName === undefined ? record.shipId : `${record.shipId} (${record.shipName})`;
  return `${record.time} ${ship} ${record.action}: ${record.outcome}${record.next === undefined ? '' : `. Next: ${record.next}`}`;
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
export function renderLogLine(line: string): string {
  const read = readLogLine(line);
  return 'line' in read ? read.line : render(read);
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
