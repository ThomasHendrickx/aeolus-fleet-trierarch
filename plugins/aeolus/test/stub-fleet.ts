import { createServer, type IncomingMessage, type Server } from 'node:http';

/** One call the stub fleet received: method, path, bearer token and JSON body. */
export interface StubCall {
  method: string;
  path: string;
  authorization: string | undefined;
  body: string;
}

/** What the stub answers: a status and a JSON body, held back until `hold` settles when one is given. */
export interface StubAnswer {
  status: number;
  body: unknown;
  /** The answer waits for this, so a test decides when the script under test may go on. */
  hold?: Promise<void>;
}

/**
 * A stand-in for the fleet's REST door: answers each call with the next
 * scripted answer, the last one again once the script runs out, and records
 * every call.
 */
export interface StubFleet {
  url: string;
  calls: StubCall[];
  close(): Promise<void>;
}

function bodyOf(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

/** Starts a stub fleet that answers each call with what `answerFor` picks for it. */
async function serve(answerFor: (call: StubCall) => StubAnswer): Promise<StubFleet> {
  const calls: StubCall[] = [];
  const server: Server = createServer((request, response) => {
    void bodyOf(request).then(async (body) => {
      const call = { method: request.method ?? '', path: request.url ?? '', authorization: request.headers.authorization, body };
      calls.push(call);
      const answer = answerFor(call);
      await answer.hold;
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('The stub fleet listens on no TCP port');
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    calls,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** The answer of a script to its call number `count`: its last one again once it runs out, none when it is empty. */
function nextOf(script: readonly StubAnswer[], count: number): StubAnswer | undefined {
  return script[Math.min(count, script.length - 1)];
}

export function startStubFleet(answers: readonly StubAnswer[]): Promise<StubFleet> {
  let count = 0;
  return serve(() => nextOf(answers, count++) ?? { status: 500, body: {} });
}

/**
 * A stub fleet that answers each path from a script of its own, so a test
 * states apart what the inbox, receive and ack answer. A path without a
 * script answers 404.
 */
export function startRoutedStubFleet(routes: Readonly<Record<string, readonly StubAnswer[]>>): Promise<StubFleet> {
  const counts = new Map<string, number>();
  return serve((call) => {
    const count = counts.get(call.path) ?? 0;
    counts.set(call.path, count + 1);
    return nextOf(routes[call.path] ?? [], count) ?? { status: 404, body: {} };
  });
}
