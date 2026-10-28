import { readdir, readFile, readlink } from 'node:fs/promises';
import type { Socket } from 'node:net';

import type { ShipId } from '@aeolus-fleet/common';

import { runCommand } from './run-command.js';

/**
 * Who may call a ship's socket (decision 0026): a process of the ship's own
 * session, under its session's root (its pane, or its container), or of the
 * trierarch itself, as its aeolus-push.sh. Anything else is refused, another
 * ship's session among them, and so is a call whose caller does not resolve.
 *
 * On Linux the caller is the peer of the connection: `ss` names the inode of
 * the socket at its other end, and the processes holding that inode are read
 * from /proc. Linux makes the accepted end of a connection in the connecting
 * side's network namespace, so a call from the ship's container is looked up
 * in that container's namespaces too, entered through the session's root, and
 * never in another ship's. On macOS `lsof` names each Unix socket's address
 * and, for a connected one, `->` its peer's: the callers are the processes
 * whose socket points at this one's, and `ps` names their parents. Each holder
 * must sit under one of the roots. Elsewhere no peer resolves, so every call
 * is refused.
 */
export type CallerCheck = (shipId: ShipId, connection: Socket) => Promise<boolean>;

/** The process a ship's session runs under on this machine, as its session runtime knows it; none while it runs no session. */
export interface SessionRoots {
  sessionRootOf(shipId: ShipId): Promise<number | undefined>;
}

const SOCKET_LINK = /^socket:\[(\d+)\]$/;
/** Deeper than any real process tree: a walk that goes on longer is not trusted. */
const MOST_ANCESTORS = 4096;

/** The descriptor of a connection, which Node keeps on its handle without documenting it. */
function descriptorOf(connection: Socket): number | undefined {
  const handle: unknown = Reflect.get(connection, '_handle');
  const fd: unknown = typeof handle === 'object' && handle !== null ? Reflect.get(handle, 'fd') : undefined;
  return typeof fd === 'number' && fd >= 0 ? fd : undefined;
}

/** The namespace of that kind a process is in, as /proc names it, such as `net:[4026531840]`. */
const namespaceOf = (pid: number | 'self', kind: 'net' | 'user') => readlink(`/proc/${String(pid)}/ns/${kind}`).catch(() => undefined);

/**
 * The Unix sockets `ss` lists: this process's network namespace's, then, when
 * the root's is another, as a container's is, that one's, entered with its user
 * namespace, which the trierarch's user owns for a rootless container.
 */
async function listings(at: { root: number | undefined; run: typeof runCommand }): Promise<string[]> {
  const { root, run } = at;
  const own = await run('ss', { args: ['-xH'] });
  const listed = [own.status === 0 ? own.stdout : ''];
  if (root !== undefined && (await namespaceOf(root, 'net')) !== (await namespaceOf('self', 'net'))) {
    const user = (await namespaceOf(root, 'user')) === (await namespaceOf('self', 'user')) ? [] : ['--user', '--preserve-credentials'];
    const theirs = await run('nsenter', { args: ['--target', String(root), '--net', ...user, 'ss', '-xH'] });
    listed.push(theirs.status === 0 ? theirs.stdout : '');
  }
  return listed;
}

/** The inode of the socket at the other end of this process's socket of that inode, as `ss` lists it: `... <local inode> <peer> <peer inode>`. */
function peerInodeIn(listed: readonly string[], inode: string): string | undefined {
  for (const line of listed.join('\n').split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.at(-3) === inode) {
      return fields.at(-1);
    }
  }
  return undefined;
}

/** Every process holding the socket of that inode; one this user cannot read holds none. */
async function holdersOfInode(inode: string): Promise<number[]> {
  const link = `socket:[${inode}]`;
  const pids = (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry));
  const holding = await Promise.all(
    pids.map(async (pid) => {
      const fds = await readdir(`/proc/${pid}/fd`).catch(() => []);
      for (const fd of fds) {
        if ((await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '')) === link) {
          return [Number(pid)];
        }
      }
      return [];
    }),
  );
  return holding.flat();
}

/** How a platform names the processes at the other end of a connection, and each process's parent. */
interface Peers {
  holdersOf(at: { fd: number; root: number | undefined }): Promise<number[]>;
  parentOf(pid: number): Promise<number | undefined>;
}

function linuxPeers(run: typeof runCommand): Peers {
  return {
    holdersOf: async ({ fd, root }) => {
      const inode = SOCKET_LINK.exec(await readlink(`/proc/self/fd/${String(fd)}`))?.[1];
      const peer = inode === undefined ? undefined : peerInodeIn(await listings({ root, run }), inode);
      return peer === undefined ? [] : holdersOfInode(peer);
    },
    // From its stat line, whose name may hold spaces and parentheses: the fields after its last `)`.
    parentOf: async (pid) => {
      const stat = await readFile(`/proc/${String(pid)}/stat`, 'utf8').catch(() => '');
      const parent = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(' ')[1]);
      return Number.isInteger(parent) ? parent : undefined;
    },
  };
}

/** A Unix socket as `lsof -F` lists it: its process and descriptor, its kernel address, and its path or `->` its peer's address. */
interface ListedSocket {
  readonly pid: number;
  readonly fd: string;
  address?: string;
  name?: string;
}

/** `lsof -F pfdDn` output: a `p` line per process, then an `f` line per file and that file's fields, one per line. */
function unixSocketsIn(listed: string): ListedSocket[] {
  const sockets: ListedSocket[] = [];
  let pid: number | undefined;
  let current: ListedSocket | undefined;
  for (const line of listed.split('\n')) {
    const field = line.slice(0, 1);
    const value = line.slice(1);
    if (field === 'p') {
      pid = Number(value);
      current = undefined;
    } else if (field === 'f' && pid !== undefined) {
      current = { pid, fd: value };
      sockets.push(current);
    } else if (current !== undefined && (field === 'd' || field === 'D') && value.startsWith('0x')) {
      current.address = value;
    } else if (current !== undefined && field === 'n') {
      current.name = value;
    }
  }
  return sockets;
}

function darwinPeers(run: typeof runCommand, ownPid: number): Peers {
  return {
    holdersOf: async ({ fd }) => {
      // lsof answers 1 when it could not read some process, and still lists the rest.
      const sockets = unixSocketsIn((await run('lsof', { args: ['-U', '-n', '-P', '-F', 'pfdDn'] })).stdout);
      const own = sockets.find((socket) => socket.pid === ownPid && socket.fd === String(fd));
      const address = own?.address;
      if (address === undefined) {
        return [];
      }
      const peer = own?.name?.startsWith('->') === true ? own.name.slice(2) : undefined;
      const holders = sockets.filter((socket) => socket !== own && (socket.name === `->${address}` || (peer !== undefined && socket.address === peer)));
      return [...new Set(holders.map((socket) => socket.pid))];
    },
    parentOf: async (pid) => {
      const shown = await run('ps', { args: ['-o', 'ppid=', '-p', String(pid)] });
      const parent = Number(shown.stdout.trim());
      return shown.status === 0 && Number.isInteger(parent) ? parent : undefined;
    },
  };
}

async function isUnder(pid: number, at: { roots: ReadonlySet<number>; peers: Peers }): Promise<boolean> {
  let current: number | undefined = pid;
  for (let step = 0; current !== undefined && current > 1 && step < MOST_ANCESTORS; step++) {
    if (at.roots.has(current)) {
      return true;
    }
    current = await at.peers.parentOf(current);
  }
  return false;
}

export function createCallerCheck(options: {
  platform: string;
  /** The process the ship's session runs under on this machine, when it runs. */
  sessionRootOf: (shipId: ShipId) => Promise<number | undefined>;
  ownPid?: number;
  run?: typeof runCommand;
}): CallerCheck {
  const ownPid = options.ownPid ?? process.pid;
  const run = options.run ?? runCommand;
  const peers = options.platform === 'linux' ? linuxPeers(run) : options.platform === 'darwin' ? darwinPeers(run, ownPid) : undefined;
  if (peers === undefined) {
    return () => Promise.resolve(false);
  }
  return async (shipId, connection) => {
    const fd = descriptorOf(connection);
    if (fd === undefined) {
      return false;
    }
    try {
      const root = await options.sessionRootOf(shipId);
      const holders = await peers.holdersOf({ fd, root });
      const roots = new Set(root === undefined ? [ownPid] : [ownPid, root]);
      const under = await Promise.all(holders.map((holder) => isUnder(holder, { roots, peers })));
      return under.length > 0 && under.every(Boolean);
    } catch {
      // A caller that does not resolve is refused, never allowed.
      return false;
    }
  };
}

/**
 * Who may call a hold's socket (headless H9): only the trierarch, never a
 * session. A caller is refused when any process holding the connection's other
 * end runs under a session's root (a hold), whichever ship's, and when it does
 * not resolve. The trierarch starts each hold outside its own process tree, so
 * the trierarch is under none of them.
 */
export function createTrierarchCallerCheck(options: {
  platform: string;
  /** The process each session runs under on this machine: every hold's. */
  sessionRoots: () => Promise<readonly number[]>;
  ownPid?: number;
  run?: typeof runCommand;
}): (connection: Socket) => Promise<boolean> {
  const run = options.run ?? runCommand;
  const peers = options.platform === 'linux' ? linuxPeers(run) : options.platform === 'darwin' ? darwinPeers(run, options.ownPid ?? process.pid) : undefined;
  if (peers === undefined) {
    return () => Promise.resolve(false);
  }
  return async (connection) => {
    const fd = descriptorOf(connection);
    if (fd === undefined) {
      return false;
    }
    try {
      const roots = new Set(await options.sessionRoots());
      const holders = await peers.holdersOf({ fd, root: undefined });
      const under = await Promise.all(holders.map((holder) => isUnder(holder, { roots, peers })));
      return under.length > 0 && under.every((isUnderASession) => !isUnderASession);
    } catch {
      // A caller that does not resolve is refused, never allowed.
      return false;
    }
  };
}
