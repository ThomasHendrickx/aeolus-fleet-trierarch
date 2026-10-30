import { chmod, mkdir, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';

import type { RefreshedCheckout } from '../core/ports.js';

/**
 * The socket of each ship the trierarch crews (decision 0026): a session holds
 * no fleet credential, so its fleet calls come over a Unix socket of its
 * ship's own, `<root>/<ship id>/fleet.sock`, in a folder only the trierarch's
 * user opens (a container mounts that folder). The trierarch adds the ship's
 * crew token, read at each call so a new crew reaches the same socket, and
 * forwards the call unchanged; the fleet's answer goes back unchanged, a 503
 * included. It answers only a caller of the ship's own session or of the
 * trierarch (the caller check), and checks only the path (the ship API and the ship protocol,
 * never register or deregister) and the size, and logs one line per call
 * without the body. It queues nothing: when the fleet gives no answer, the
 * session gets none either. One call it answers itself, never the fleet's: a
 * refresh of its ship's read-only checkouts (#1182), which answers the
 * revision each now holds, or why it could not.
 */

/** The most a call's body may hold: a 256 KB payload with the JSON around it (aeolus-fleet decision 0006). */
export const SHIP_CALL_MAX_BYTES = 320 * 1024;

const SOCKET_FILE = 'fleet.sock';
/** A ship call is one word under the ship API: `/api/v1/ship/send`. */
const SHIP_CALL = /^\/api\/v1\/ship\/([A-Za-z]+)$/;
/** The calls that make or end a crew: only the trierarch makes them, never a session. */
const CREW_CALLS = new Set(['register', 'deregister']);
/** The ship protocol, which a session reads at each start (`aeolus-fleet.sh protocol`). */
const PROTOCOL = '/api/v1/openapi.json';
/** A refresh of the ship's read-only checkouts (`aeolus-checkouts.sh refresh`), which the trierarch answers itself (#1182). */
const REFRESH_CHECKOUTS = '/trierarch/checkouts/refresh';

export interface ShipSockets {
  /** Opens the ship's socket, or keeps the one open; answers its path. */
  open(shipId: ShipId): Promise<string>;
  /** Closes the ship's socket and removes its file: a call then gets no answer. */
  close(shipId: ShipId): Promise<void>;
  closeAll(): Promise<void>;
}

/** Whether the socket forwards a call to this path: the ship API but crewing, and the protocol. */
function isForwarded(method: string, path: string): boolean {
  if (method === 'GET' && path === PROTOCOL) {
    return true;
  }
  const call = SHIP_CALL.exec(path)?.[1];
  return call !== undefined && !CREW_CALLS.has(call);
}

/** The body of a call, or too large once it passes the bound. */
function bodyOf(incoming: IncomingMessage): Promise<Buffer | 'too large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    incoming.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > SHIP_CALL_MAX_BYTES) {
        resolve('too large');
        return;
      }
      chunks.push(chunk);
    });
    incoming.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    incoming.on('error', reject);
  });
}

/** The code a refusal of each status says, as the fleet's refusals do. */
const REFUSAL_CODES = { 403: 'FORBIDDEN', 413: 'PAYLOAD_TOO_LARGE', 500: 'INTERNAL_SERVER_ERROR' } as const;

function refuse(response: ServerResponse, refusal: { status: keyof typeof REFUSAL_CODES; message: string }): void {
  const { status, message } = refusal;
  response.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
  response.end(JSON.stringify({ code: REFUSAL_CODES[status], message }));
}

export function createShipSockets(options: {
  root: string;
  fleetUrl: string;
  crewTokenOf: (shipId: ShipId) => Promise<string | undefined>;
  /** Whether the process at the other end of the connection may call the ship's socket. */
  mayCall: (shipId: ShipId, connection: Socket) => Promise<boolean>;
  log: (line: string) => void;
  /** Brings the ship's read-only checkouts to the latest main (#1182). */
  refreshCheckouts: (shipId: ShipId) => Promise<readonly RefreshedCheckout[]>;
}): ShipSockets {
  const servers = new Map<ShipId, { server: Server; path: string }>();

  const handle = async (shipId: ShipId, call: { incoming: IncomingMessage; response: ServerResponse }): Promise<void> => {
    const { incoming, response } = call;
    const method = incoming.method ?? 'GET';
    const path = incoming.url ?? '';
    const said = (outcome: string): void => {
      options.log(`${shipId} ${method} ${path} ${outcome}`);
    };
    if (!(await options.mayCall(shipId, incoming.socket))) {
      refuse(response, { status: 403, message: "This socket answers only its ship's own session" });
      said('403');
      return;
    }
    if (method === 'POST' && path === REFRESH_CHECKOUTS) {
      try {
        const checkouts = await options.refreshCheckouts(shipId);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ checkouts }));
        said('200');
      } catch (error) {
        refuse(response, { status: 500, message: error instanceof Error ? error.message : String(error) });
        said('500');
      }
      return;
    }
    if (!isForwarded(method, path)) {
      refuse(response, { status: 403, message: 'This socket forwards only ship calls, never register or deregister' });
      said('403');
      return;
    }
    const body = await bodyOf(incoming);
    if (body === 'too large') {
      refuse(response, { status: 413, message: `A call is at most ${String(SHIP_CALL_MAX_BYTES)} bytes` });
      said('413');
      return;
    }
    const crewToken = await options.crewTokenOf(shipId);
    const contentType = incoming.headers['content-type'];
    let answer: Response;
    try {
      answer = await fetch(`${options.fleetUrl}${path}`, {
        method,
        headers: { ...(crewToken !== undefined && { authorization: `Bearer ${crewToken}` }), ...(contentType !== undefined && { 'content-type': contentType }) },
        ...(method !== 'GET' && method !== 'HEAD' && { body }),
      });
    } catch {
      // No answer from the fleet: none for the session either, as when it calls a fleet that is down.
      response.socket?.destroy();
      said('no answer');
      return;
    }
    const answered = Buffer.from(await answer.arrayBuffer());
    const answeredType = answer.headers.get('content-type');
    response.writeHead(answer.status, answeredType === null ? {} : { 'content-type': answeredType });
    response.end(answered);
    said(String(answer.status));
  };

  const close = async (shipId: ShipId): Promise<void> => {
    const open = servers.get(shipId);
    servers.delete(shipId);
    if (open !== undefined) {
      open.server.closeAllConnections();
      await new Promise<void>((resolve) => open.server.close(() => { resolve(); }));
    }
    await rm(join(options.root, shipId, SOCKET_FILE), { force: true });
  };

  return {
    open: async (shipId) => {
      const open = servers.get(shipId);
      if (open !== undefined) {
        return open.path;
      }
      const folder = join(options.root, shipId);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await chmod(folder, 0o700);
      const path = join(folder, SOCKET_FILE);
      // A socket file left by a trierarch that stopped: nothing listens on it any more.
      await rm(path, { force: true });
      const server = createServer((incoming, response) => {
        void handle(shipId, { incoming, response }).catch(() => {
          response.socket?.destroy();
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, () => {
          server.off('error', reject);
          resolve();
        });
      });
      servers.set(shipId, { server, path });
      return path;
    },
    close,
    closeAll: async () => {
      await Promise.all([...servers.keys()].map(close));
    },
  };
}
