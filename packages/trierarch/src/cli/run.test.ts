import { describe, expect, it } from 'vitest';

import type { Delivery } from '../core/ports.js';
import { loop } from './run.js';

/** A receive that waits, as the fleet's long poll does, until the stop aborts it. */
function longPoll(signal: AbortSignal): Promise<Delivery[]> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(new Error('stopped'));
    });
  });
}

const quiet = { warn: () => undefined };
const STOP_WITHIN_MS = 200;

describe('the run loop', () => {
  it('ends at once on stop, even while a receive waits on the fleet', async () => {
    const stopping = new AbortController();
    const started = Date.now();

    const running = loop({ receive: longPoll, handle: () => Promise.resolve(), pass: () => Promise.resolve(), signal: stopping.signal, logger: quiet, intervalMs: 60_000 });
    setTimeout(() => {
      stopping.abort();
    }, 20);
    await running;

    expect(Date.now() - started).toBeLessThan(STOP_WITHIN_MS);
  });

  it('ends at once on stop while it waits after a failure', async () => {
    const stopping = new AbortController();
    const warned: string[] = [];
    const started = Date.now();

    const running = loop({
      receive: () => Promise.reject(new Error('The fleet cannot be reached')),
      handle: () => Promise.resolve(),
      pass: () => Promise.resolve(),
      signal: stopping.signal,
      logger: { warn: (message) => warned.push(message) },
      intervalMs: 60_000,
    });
    setTimeout(() => {
      stopping.abort();
    }, 20);
    await running;

    expect(Date.now() - started).toBeLessThan(STOP_WITHIN_MS);
    expect(warned).toEqual(['The loop failed and goes on: The fleet cannot be reached']);
  });

  it('receives again after the fleet could not be reached, as while it restarts, and handles what then comes', async () => {
    const stopping = new AbortController();
    const warned: string[] = [];
    const handled: string[] = [];
    const delivery = { deliveryId: 'dlv_1', messageId: 'msg_1', senderShipId: 'shp_01m487vd5pdz6zh6s0jdnkg9p6', contentType: 'text/plain', payload: '' } as const;
    let receives = 0;

    await loop({
      receive: (signal) => {
        receives += 1;
        if (receives === 1) {
          return Promise.reject(new Error('The fleet at https://fleet.example.com cannot be reached: it answered 502 without JSON, as while it restarts'));
        }
        return receives === 2 ? Promise.resolve([delivery]) : longPoll(signal);
      },
      handle: (received) => {
        handled.push(received.deliveryId);
        stopping.abort();
        return Promise.resolve();
      },
      pass: () => Promise.resolve(),
      signal: stopping.signal,
      logger: { warn: (message) => warned.push(message) },
      intervalMs: 1,
    });

    expect(warned).toEqual(['The loop failed and goes on: The fleet at https://fleet.example.com cannot be reached: it answered 502 without JSON, as while it restarts']);
    expect(handled).toEqual(['dlv_1']);
  });

  it('handles each delivery it receives and runs a pass', async () => {
    const stopping = new AbortController();
    const handled: string[] = [];
    let passes = 0;
    const delivery = { deliveryId: 'dlv_1', messageId: 'msg_1', senderShipId: 'shp_01m487vd5pdz6zh6s0jdnkg9p6', contentType: 'text/plain', payload: '' } as const;
    let isFirst = true;

    await loop({
      receive: (signal) => {
        if (isFirst) {
          isFirst = false;
          return Promise.resolve([delivery]);
        }
        return longPoll(signal);
      },
      handle: (received) => {
        handled.push(received.deliveryId);
        return Promise.resolve();
      },
      pass: () => {
        passes += 1;
        stopping.abort();
        return Promise.resolve();
      },
      signal: stopping.signal,
      logger: quiet,
      intervalMs: 0,
    });

    expect(handled).toEqual(['dlv_1']);
    expect(passes).toBe(1);
  });
});
