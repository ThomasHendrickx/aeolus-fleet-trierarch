import { createServer, type ServerResponse } from 'node:http';

import { describe, expect, it } from 'vitest';

import { newId } from '../../test/support/in-memory.js';
import { createRestFleet } from './rest-fleet.js';

/** Nothing listens here: a connection is refused at once. */
const NOWHERE = 'http://127.0.0.1:9';

/** How long a cut-off answer waits after its first bytes before its connection drops. */
const CUT_AFTER_MS = 20;

/** A fleet that answers every call as `answer` does, for the length of `run`. */
async function aFleetThat(answer: (response: ServerResponse) => void, run: (fleetUrl: string) => Promise<void>): Promise<void> {
  const server = createServer((_request, response) => {
    answer(response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${String(port)}`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

describe('the fleet over REST', () => {
  it('says which fleet cannot be reached, rather than only that a fetch failed', async () => {
    await expect(createRestFleet({ fleetUrl: NOWHERE, crewToken: '' }).registerSelf({ shipId: newId('ship'), secret: 'aeolus_sk_v1_x' })).rejects.toThrow(
      `The fleet at ${NOWHERE} cannot be reached: fetch failed`,
    );
  });

  it('ends a receive at once when it is stopped, while the fleet still holds the long poll', async () => {
    const server = createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const stopping = new AbortController();
    try {
      const receiving = createRestFleet({ fleetUrl: `http://127.0.0.1:${String(port)}`, crewToken: 'aeolus_ct_v1_x' }).receive(stopping.signal);
      setTimeout(() => {
        stopping.abort();
      }, 20);

      await expect(receiving).rejects.toThrow();
      expect(stopping.signal.aborted).toBe(true);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('says the fleet cannot be reached when it answers with an empty body, as while it restarts, rather than failing to read JSON', async () => {
    await aFleetThat(
      (response) => response.writeHead(200, { 'content-length': '0' }).end(),
      async (fleetUrl) => {
        await expect(createRestFleet({ fleetUrl, crewToken: 'aeolus_ct_v1_x' }).receive()).rejects.toThrow(
          `The fleet at ${fleetUrl} cannot be reached: it answered 200 without JSON, as while it restarts`,
        );
      },
    );
  });

  it('says the fleet cannot be reached when a proxy answers for it with a page, not JSON', async () => {
    await aFleetThat(
      (response) => response.writeHead(502, { 'content-type': 'text/html' }).end('<html>Bad Gateway</html>'),
      async (fleetUrl) => {
        await expect(createRestFleet({ fleetUrl, crewToken: 'aeolus_ct_v1_x' }).whoami()).rejects.toThrow(
          `The fleet at ${fleetUrl} cannot be reached: it answered 502 without JSON, as while it restarts`,
        );
      },
    );
  });

  it('says the fleet cannot be reached when its answer is cut off midway', async () => {
    await aFleetThat(
      (response) => {
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
        // Cut once the headers and the first bytes are out, so the fetch has an answer whose body never ends.
        response.write('{"deliveries":[', () => setTimeout(() => response.socket?.destroy(), CUT_AFTER_MS));
      },
      async (fleetUrl) => {
        await expect(createRestFleet({ fleetUrl, crewToken: 'aeolus_ct_v1_x' }).receive()).rejects.toThrow(`The fleet at ${fleetUrl} cannot be reached`);
      },
    );
  });

  it('gives a crew request back with the settings version it tried and the reason, and answers given back once the fleet takes it (#382)', async () => {
    const shipId = newId('ship');
    const asked: { method?: string; url?: string; body: string }[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on('end', () => {
        asked.push({ ...(request.method !== undefined && { method: request.method }), ...(request.url !== undefined && { url: request.url }), body });
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const answer = await createRestFleet({ fleetUrl: `http://127.0.0.1:${String(port)}`, crewToken: 'aeolus_ct_v1_x' }).giveBack(shipId, { settingsVersion: 2, reason: 'mac-studio: harness: no codex' });

      expect(answer).toEqual({ kind: 'givenBack' });
      expect(asked).toEqual([{ method: 'POST', url: '/api/v1/fleet/giveBackCrewRequest', body: JSON.stringify({ shipId, settingsVersion: 2, reason: 'mac-studio: harness: no codex' }) }]);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('answers the code and message when the fleet refuses a give-back, rather than throwing (#382)', async () => {
    await aFleetThat(
      (response) => response.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'CREW_REQUEST_FINAL', message: "scout's crew is final (running)" })),
      async (fleetUrl) => {
        await expect(createRestFleet({ fleetUrl, crewToken: 'aeolus_ct_v1_x' }).giveBack(newId('ship'), { settingsVersion: 1, reason: 'mac-studio: harness: no codex' })).resolves.toEqual({
          kind: 'refused',
          code: 'CREW_REQUEST_FINAL',
          message: "scout's crew is final (running)",
        });
      },
    );
  });
});
