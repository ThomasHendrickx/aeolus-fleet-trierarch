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
  streams: StubCall[];
  streamOpenTimes: number[];
  close(): Promise<void>;
}

/** Scripted wake streams; a closed one drops its connection after its body. */
interface StubWakeup {
  status: number;
  body: string;
  isClosed?: boolean;
  keepAliveMilliseconds?: number;
}

interface StubOptions {
  socket?: string;
  wakeups?: readonly StubWakeup[];
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

/** Starts a stub fleet that answers each call with what `answerFor` picks for it: on a TCP port, or on a Unix socket at `socket`. */
async function serve(answerFor: (call: StubCall) => StubAnswer, options: StubOptions = {}): Promise<StubFleet> {
  const calls: StubCall[] = [];
  const streams: StubCall[] = [];
  const streamOpenTimes: number[] = [];
  const server: Server = createServer((request, response) => {
    void bodyOf(request).then(async (body) => {
      const call = { method: request.method ?? '', path: request.url ?? '', authorization: request.headers.authorization, body };
      if (call.path === '/api/v1/ship/wakeups') {
        streams.push(call);
        streamOpenTimes.push(Date.now());
        const stream = options.wakeups?.[Math.min(streams.length - 1, options.wakeups.length - 1)];
        response.writeHead(stream?.status ?? 200, { 'content-type': 'text/event-stream' });
        response.write(stream?.body ?? 'event: wake\ndata: {"reason":"open"}\n\n');
        response.flushHeaders();
        if (stream?.isClosed === true) { response.end(); return; }
        // Existing hand-over tests use a core that keeps offering wake hints.
        if (stream === undefined || stream.keepAliveMilliseconds !== undefined) {
          const timer = setInterval(() => response.write(stream === undefined ? 'event: wake\ndata: {}\n\n' : ': keep-alive\n\n'), stream?.keepAliveMilliseconds ?? 50);
          response.on('close', () => { clearInterval(timer); });
        }
        return;
      }
      calls.push(call);
      const answer = answerFor(call);
      await answer.hold;
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
  });
  const url = await new Promise<string>((resolve) => {
    if (options.socket !== undefined) {
      server.listen(options.socket, () => {
        resolve(`unix:${options.socket}`);
      });
      return;
    }
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? `http://127.0.0.1:${String(address.port)}` : '');
    });
  });
  return {
    url,
    calls,
    streams,
    streamOpenTimes,
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

export function startStubFleet(answers: readonly StubAnswer[], options: StubOptions = {}): Promise<StubFleet> {
  let count = 0;
  return serve(() => nextOf(answers, count++) ?? { status: 500, body: {} }, options);
}

/**
 * A stub fleet that answers each path from a script of its own, so a test
 * states apart what the inbox, receive and ack answer. A path without a
 * script answers 404.
 */
export function startRoutedStubFleet(routes: Readonly<Record<string, readonly StubAnswer[]>>, options: StubOptions = {}): Promise<StubFleet> {
  const counts = new Map<string, number>();
  return serve((call) => {
    const count = counts.get(call.path) ?? 0;
    counts.set(call.path, count + 1);
    return nextOf(routes[call.path] ?? [], count) ?? { status: 404, body: {} };
  }, options);
}
