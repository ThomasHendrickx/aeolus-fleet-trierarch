import { createServer, type ServerResponse } from 'node:http';

import { describe, expect, it } from 'vitest';

import { newId } from '../../test/support/in-memory.js';
import { createRestFleet, FleetRefusal } from './rest-fleet.js';

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

/** The fleet's refusal while every pool connection is taken: nothing was stored (#542). */
const BUSY = { status: 503, body: { code: 'SERVICE_UNAVAILABLE', message: 'The fleet is busy; nothing was stored. Make the same call again (for send, with the same idempotency key).' } };

/** One call a fleet received: its path and body, and when it came. */
interface Asked {
  url: string;
  body: string;
  at: number;
}

/** A fleet that answers each call with the next of `answers`, the last one again once they run out, and records each call. */
async function aFleetAnswering(answers: readonly { status: number; body: unknown }[], run: (fleetUrl: string, asked: Asked[]) => Promise<void>): Promise<void> {
  const asked: Asked[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      asked.push({ url: request.url ?? '', body, at: Date.now() });
      const answer = answers[Math.min(asked.length, answers.length) - 1] ?? BUSY;
      response.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${String(port)}`, asked);
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

  it('reads each crew request assigned to it with whether its crew is final, as the fleet holds it (#477)', async () => {
    const shipId = newId('ship');
    const ownerShipId = newId('ship');
    await aFleetThat(
      (response) =>
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify([{ shipId, settings: { harness: 'codex' }, settingsVersion: 2, requestedAt: '2026-10-10T09:00:00.000Z', status: 'crewing', isFinal: true, ownerShipId, ownerName: 'thomas' }])),
      async (fleetUrl) => {
        await expect(createRestFleet({ fleetUrl, crewToken: 'aeolus_ct_v1_x' }).assignedRequests()).resolves.toEqual([
          { shipId, settings: { harness: 'codex' }, settingsVersion: 2, status: 'crewing', isFinal: true, owner: { shipId: ownerShipId, name: 'thomas' } },
        ]);
      },
    );
  });

  it("reads a session's inbox: how many deliveries wait, and how many of them are forced (decision 0040)", async () => {
    await aFleetThat(
      (response) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ waiting: 3, forced: 1 })),
      async (fleetUrl) => {
        await expect(createRestFleet({ fleetUrl, crewToken: 'aeolus_ct_v1_x' }).inbox('aeolus_ct_v1_session')).resolves.toEqual({ kind: 'waiting', count: 3, forced: 1 });
      },
    );
  });

  it('registers a session with its own harness, as the fleet then lists its ship (aeolus-fleet#1408)', async () => {
    await aFleetAnswering([{ status: 200, body: { crewToken: 'aeolus_ct_v1_session' } }], async (fleetUrl, asked) => {
      const shipId = newId('ship');

      await expect(createRestFleet({ fleetUrl, crewToken: 'aeolus_ct_v1_x' }).register({ shipId, secret: 'aeolus_sk_v1_x', harness: 'codex' })).resolves.toEqual({ crewToken: 'aeolus_ct_v1_session' });

      expect(asked.map(({ url, body }) => ({ url, body }))).toEqual([{ url: '/api/v1/ship/register', body: JSON.stringify({ shipId, secret: 'aeolus_sk_v1_x', harness: 'codex', location: { kind: 'DEVICE' } }) }]);
    });
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

describe("the fleet over REST: trouble to a ship's owner (decision 0045)", () => {
  const assignedAnswer = (request: Record<string, unknown>) => (response: ServerResponse) =>
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([{ settings: { harness: 'codex' }, settingsVersion: 1, requestedAt: '2026-10-10T09:00:00.000Z', status: null, isFinal: false, ...request }]));

  it("reads each assigned request with its ship's owner, by id and name", async () => {
    const shipId = newId('ship');
    const ownerShipId = newId('ship');
    await aFleetThat(assignedAnswer({ shipId, ownerShipId, ownerName: 'thomas' }), async (fleetUrl) => {
      await expect(createRestFleet({ fleetUrl, crewToken: 'aeolus_ct_v1_x' }).assignedRequests()).resolves.toMatchObject([{ shipId, owner: { shipId: ownerShipId, name: 'thomas' } }]);
    });
  });

  it('reads a request whose ship has no owner as owned by none', async () => {
    const shipId = newId('ship');
    await aFleetThat(assignedAnswer({ shipId, ownerShipId: null, ownerName: null }), async (fleetUrl) => {
      await expect(createRestFleet({ fleetUrl, crewToken: 'aeolus_ct_v1_x' }).assignedRequests()).resolves.toMatchObject([{ shipId, owner: null }]);
    });
  });

  it("asks the trierarch plugin's ship for the trusted repositories, by its id (aeolus-fleet#384)", async () => {
    const pluginShipId = newId('ship');
    await aFleetAnswering([{ status: 200, body: { messageId: newId('message') } }], async (fleetUrl, asked) => {
      await createRestFleet({ fleetUrl, crewToken: 'aeolus_ct_v1_x' }).askForTrustedRepositories(pluginShipId);

      expect(asked.map(({ url }) => url)).toEqual(['/api/v1/ship/send']);
      expect(JSON.parse(asked[0]?.body ?? '')).toMatchObject({ selector: { kind: 'ship', shipId: pluginShipId }, contentType: 'application/vnd.aeolus.trierarch.trusted-repositories-request+json', payload: '{}' });
    });
  });

  it("sends the owner's ship the report in markdown, by its id, and answers sent", async () => {
    const ownerShipId = newId('ship');
    await aFleetAnswering([{ status: 200, body: { messageId: newId('message') } }], async (fleetUrl, asked) => {
      const answer = await createRestFleet({ fleetUrl, crewToken: 'aeolus_ct_v1_x' }).reportToOwner({ ownerShipId, text: 'scout crashed', idempotencyKey: 'report-1' });

      expect(answer).toEqual({ kind: 'sent' });
      expect(asked.map(({ url }) => url)).toEqual(['/api/v1/ship/send']);
      expect(JSON.parse(asked[0]?.body ?? '')).toMatchObject({ selector: { kind: 'ship', shipId: ownerShipId }, payload: 'scout crashed', contentType: 'text/markdown', idempotencyKey: 'report-1' });
    });
  });

  it('answers the code and message when the fleet refuses the report to the owner, rather than throwing', async () => {
    await aFleetThat(
      (response) => response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'NOT_REACHABLE', message: 'no rule lets mac-studio reach thomas' })),
      async (fleetUrl) => {
        await expect(createRestFleet({ fleetUrl, crewToken: 'aeolus_ct_v1_x' }).reportToOwner({ ownerShipId: newId('ship'), text: 'scout crashed', idempotencyKey: 'report-1' })).resolves.toEqual({
          kind: 'refused',
          code: 'NOT_REACHABLE',
          message: 'no rule lets mac-studio reach thomas',
        });
      },
    );
  });
});

describe('the fleet over REST while it is busy (#546)', () => {
  it('reports to argo in markdown, again by itself with the same idempotency key while the fleet is busy (#849)', async () => {
    await aFleetAnswering([BUSY, BUSY, { status: 200, body: { messageId: newId('message') } }], async (fleetUrl, asked) => {
      await createRestFleet({ fleetUrl, crewToken: 'aeolus_ct_v1_x', busyWaitsMs: [1, 1, 1, 1] }).reportToArgo({ text: 'scout crashed', idempotencyKey: 'report-1' });

      expect(asked.map(({ url, body }) => [url, body])).toEqual(Array.from({ length: 3 }, () => ['/api/v1/ship/send', asked[0]?.body]));
      expect(JSON.parse(asked[0]?.body ?? '')).toMatchObject({ idempotencyKey: 'report-1', contentType: 'text/markdown' });
    });
  });

  it('waits longer before each next call while the fleet stays busy', async () => {
    await aFleetAnswering([BUSY, BUSY, { status: 200, body: { shipId: newId('ship'), name: 'trierarch' } }], async (fleetUrl, asked) => {
      await createRestFleet({ fleetUrl, crewToken: 'aeolus_ct_v1_x', busyWaitsMs: [100, 300], random: () => 1 }).whoami();

      const [first = 0, second = 0, third = 0] = asked.map(({ at }) => at);
      expect(second - first).toBeGreaterThanOrEqual(90);
      expect(third - second).toBeGreaterThanOrEqual(290);
    });
  });

  it('draws each wait between half and all of it, so callers refused together do not call again together (#610)', async () => {
    await aFleetAnswering([BUSY, BUSY, { status: 200, body: { shipId: newId('ship'), name: 'trierarch' } }], async (fleetUrl) => {
      const draws = [0, 1];
      const waited: number[] = [];
      await createRestFleet({ fleetUrl, crewToken: 'aeolus_ct_v1_x', busyWaitsMs: [400, 400], random: () => draws.shift() ?? 0, wait: (waitMs) => {
        waited.push(waitMs);
        return Promise.resolve();
      } }).whoami();

      expect(waited).toEqual([200, 400]);
    });
  });

  it('throws the busy refusal once every wait is spent, calling once more than it waits', async () => {
    await aFleetAnswering([BUSY], async (fleetUrl, asked) => {
      const whoami = createRestFleet({ fleetUrl, crewToken: 'aeolus_ct_v1_x', busyWaitsMs: [1, 1, 1] }).whoami();

      await expect(whoami).rejects.toThrow(new FleetRefusal('SERVICE_UNAVAILABLE', BUSY.body.message));
      expect(asked).toHaveLength(4);
    });
  });

  it('calls once, without waiting, on any other refusal', async () => {
    await aFleetAnswering([{ status: 500, body: { code: 'INTERNAL_SERVER_ERROR', message: 'Failed' } }], async (fleetUrl, asked) => {
      await expect(createRestFleet({ fleetUrl, crewToken: 'aeolus_ct_v1_x', busyWaitsMs: [1] }).whoami()).rejects.toThrow('INTERNAL_SERVER_ERROR');
      expect(asked).toHaveLength(1);
    });
  });

  it('ends a receive at once when it is stopped while it waits to call again', async () => {
    await aFleetAnswering([BUSY], async (fleetUrl, asked) => {
      const stopping = new AbortController();
      const ended = createRestFleet({ fleetUrl, crewToken: 'aeolus_ct_v1_x', busyWaitsMs: [60_000] })
        .receive(stopping.signal)
        .catch((error: unknown) => error);
      await expect.poll(() => asked.length).toBe(1);
      stopping.abort();

      await expect(ended).resolves.toMatchObject({ name: 'AbortError' });
      expect(asked).toHaveLength(1);
    });
  });

  it('writes the activity of the sessions in one call, with the interval, as ISO times, leaving out a tool a kind has none of', async () => {
    const scout = newId('ship');
    const hand = newId('ship');
    await aFleetAnswering([{ status: 200, body: { refused: [] } }], async (fleetUrl, asked) => {
      const fleet = createRestFleet({ fleetUrl, crewToken: 'aeolus_ct_v1_x' });

      await fleet.reportActivity({
        intervalSeconds: 30,
        activities: [
          { shipId: scout, at: new Date('2026-10-09T08:00:00Z'), kind: 'tool', tool: 'Bash' },
          { shipId: hand, at: new Date('2026-10-09T08:00:05Z'), kind: 'text' },
        ],
      });

      expect(asked.map(({ url }) => url)).toEqual(['/api/v1/fleet/reportActivity']);
      expect(JSON.parse(asked[0]?.body ?? '')).toEqual({
        intervalSeconds: 30,
        activities: [
          { shipId: scout, at: '2026-10-09T08:00:00.000Z', kind: 'tool', tool: 'Bash' },
          { shipId: hand, at: '2026-10-09T08:00:05.000Z', kind: 'text' },
        ],
      });
    });
  });

  it('writes the activity of 101 sessions in two calls, the fleet taking at most 100', async () => {
    await aFleetAnswering([{ status: 200, body: { refused: [] } }], async (fleetUrl, asked) => {
      const fleet = createRestFleet({ fleetUrl, crewToken: 'aeolus_ct_v1_x' });
      const activities = Array.from({ length: 101 }, () => ({ shipId: newId('ship'), at: new Date('2026-10-09T08:00:00Z'), kind: 'text' as const }));

      await fleet.reportActivity({ intervalSeconds: 30, activities });

      expect(asked.map(({ body }) => (JSON.parse(body) as { activities: unknown[] }).activities.length)).toEqual([100, 1]);
    });
  });
});
