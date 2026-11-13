import { chmod, mkdir, rm, rmdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';

import { shipSockets, SOCKET_FILE } from './paths.js';

/**
 * The socket of each ship the trierarch crews (decision 0026): a session holds
 * no fleet credential, so its fleet calls come over a Unix socket of its
 * ship's own, `<ship's folder>/sockets/fleet.sock`, or for a ship crewed before
 * the ship folders `<root>/<ship id>/fleet.sock`, in a folder only the
 * trierarch's user opens (a container mounts that folder). The trierarch adds the ship's
 * crew token, read at each call so a new crew reaches the same socket, and
 * forwards the call unchanged; the fleet's answer goes back unchanged, a 503
 * included. It answers only a caller of the ship's own session or of the
 * trierarch (the caller check), and checks only the path (the ship API, the
 * fleet API and the ship protocol, never register or deregister) and the
 * size: core decides each fleet call by the ship's scopes and reach
 * (decision 0057). It logs one line per call without the body. It queues nothing: when the fleet gives no answer, the
 * session gets none either.
 */

/** The most a call's body may hold: a 256 KB payload with the JSON around it (aeolus-fleet decision 0006). */
export const SHIP_CALL_MAX_BYTES = 320 * 1024;

/** A call is one word under the ship API or the fleet API: `/api/v1/ship/send`, `/api/v1/fleet/commission`. */
const FORWARDED_CALL = /^\/api\/v1\/(?:ship|fleet)\/([A-Za-z]+)$/;
/** The calls that make or end a crew: only the trierarch makes them, never a session. */
const CREW_CALLS = new Set(['register', 'deregister']);
/** The ship protocol, which a session reads at each start (`aeolus-fleet.sh protocol`). */
const PROTOCOL = '/api/v1/openapi.json';

export interface ShipSockets {
  /** Opens the ship's socket in its ship's folder, or for a ship crewed before the ship folders (none) where it was, or keeps the one open; answers its path. */
  open(shipId: ShipId, shipFolder?: string): Promise<string>;
  /**
   * Closes the ship's socket and removes its file: a call then gets no answer.
   * The folder of a ship crewed before the ship folders goes with it, as
   * nothing else is in it; a ship's folder goes with the ship.
   */
  close(shipId: ShipId, shipFolder?: string): Promise<void>;
  /** Closes every socket open, each folder staying for the session's next socket. */
  closeAll(): Promise<void>;
}

/** Whether the socket forwards a call to this path: the ship API and the fleet API but crewing, and the protocol. */
function isForwarded(method: string, path: string): boolean {
  if (method === 'GET' && path === PROTOCOL) {
    return true;
  }
  const call = FORWARDED_CALL.exec(path)?.[1];
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
    if (!isForwarded(method, path)) {
      refuse(response, { status: 403, message: 'This socket forwards only ship and fleet calls, never register or deregister' });
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

  /** Closes the ship's socket if it is open and removes its file, its folder staying. */
  const closeOpen = async (shipId: ShipId): Promise<void> => {
    const open = servers.get(shipId);
    servers.delete(shipId);
    if (open !== undefined) {
      open.server.closeAllConnections();
      await new Promise<void>((resolve) => open.server.close(() => { resolve(); }));
      await rm(open.path, { force: true });
    }
  };

  return {
    open: async (shipId, shipFolder) => {
      const open = servers.get(shipId);
      if (open !== undefined) {
        return open.path;
      }
      const folder = shipSockets(options.root, { shipId, ...(shipFolder !== undefined && { shipFolder }) });
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
    close: async (shipId, shipFolder) => {
      await closeOpen(shipId);
      const folder = shipSockets(options.root, { shipId, ...(shipFolder !== undefined && { shipFolder }) });
      await rm(join(folder, SOCKET_FILE), { force: true });
      if (shipFolder === undefined) {
        // Gone only when nothing else is in it.
        await rmdir(folder).catch(() => undefined);
      }
    },
    closeAll: async () => {
      await Promise.all([...servers.keys()].map(closeOpen));
    },
  };
}
