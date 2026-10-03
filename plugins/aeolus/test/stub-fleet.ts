import { createServer, type IncomingMessage, type Server } from 'node:http';

/** One call the stub fleet received: path, bearer token and JSON body. */
export interface StubCall {
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

export async function startStubFleet(answers: readonly StubAnswer[]): Promise<StubFleet> {
  const calls: StubCall[] = [];
  const server: Server = createServer((request, response) => {
    void bodyOf(request).then(async (body) => {
      calls.push({ path: request.url ?? '', authorization: request.headers.authorization, body });
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)] ?? { status: 500, body: {} };
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
        server.close(() => {
          resolve();
        });
      }),
  };
}
