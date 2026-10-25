import { connect } from 'node:net';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';
import { z } from 'zod';

/**
 * How the trierarch talks to a session's hold (headless H8, H9): the hold's
 * files in the session's own folder, `<sessions>/<ship id>/`, and its socket's
 * calls, one JSON line each way. The trierarch speaks only its own version of
 * this protocol: a hold of another version is replaced (H19).
 */

/** A session's hold files, in its folder under the sessions folder. */
export interface HoldFiles {
  readonly folder: string;
  readonly socket: string;
  readonly pid: string;
  /** Every event line the harness writes, appended. */
  readonly events: string;
  /** The harness's own session id, as its first event names it, so a start resumes it. */
  readonly sessionId: string;
}

export function holdFilesOf(sessions: string, shipId: ShipId): HoldFiles {
  const folder = join(sessions, shipId);
  return { folder, socket: join(folder, 'hold.sock'), pid: join(folder, 'hold.pid'), events: join(folder, 'events.jsonl'), sessionId: join(folder, 'session-id') };
}

export const holdRequestSchema = z.discriminatedUnion('call', [
  z.object({ call: z.literal('send'), line: z.string() }),
  z.object({ call: z.literal('interrupt') }),
  z.object({ call: z.literal('state') }),
]);

export type HoldRequest = z.infer<typeof holdRequestSchema>;

export const holdAnswerSchema = z.discriminatedUnion('isOk', [
  z.object({ isOk: z.literal(true), state: z.object({ status: z.literal('running'), version: z.string(), sessionId: z.string().optional() }).optional() }),
  z.object({ isOk: z.literal(false), error: z.string() }),
]);

export type HoldAnswer = z.infer<typeof holdAnswerSchema>;

/** The answer a hold gives a caller that is not the trierarch. */
export const REFUSED = 'refused: only the trierarch talks to a hold';

/** A line as JSON; undefined when it holds none. */
export function parsedLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** Calls the hold at the socket and answers what it said; a hold that does not answer within the time, or ends the call unanswered, throws. */
export function callHold(call: { socket: string; request: HoldRequest; timeoutMs: number }): Promise<HoldAnswer> {
  const { socket, request, timeoutMs } = call;
  return new Promise((resolve, reject) => {
    const connection = connect(socket);
    let received = '';
    const timer = setTimeout(() => {
      connection.destroy();
      reject(new Error(`the hold at ${socket} did not answer ${request.call} within ${String(timeoutMs)} ms`));
    }, timeoutMs);
    connection.on('connect', () => connection.write(`${JSON.stringify(request)}\n`));
    connection.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
    });
    connection.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    connection.on('close', () => {
      clearTimeout(timer);
      const answer = holdAnswerSchema.safeParse(parsedLine(received.split('\n')[0] ?? ''));
      if (answer.success) {
        resolve(answer.data);
      } else {
        reject(new Error(`the hold at ${socket} gave no answer to ${request.call}`));
      }
    });
  });
}
