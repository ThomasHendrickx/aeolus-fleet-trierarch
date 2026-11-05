import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../../test/support/in-memory.js';
import { createCallerCheck, createTrierarchCallerCheck } from './caller-check.js';
import type { CommandResult } from './run-command.js';

// Who may call a ship's socket (decision 0026): a process of its ship's own
// session, or of the trierarch itself, resolved from the peer of the
// connection on the real kernel: Linux and macOS. Elsewhere no peer resolves,
// so every call is refused.

const NODE = process.execPath;
/** A process that connects to the socket and stays, writing its pid first where it is told to. */
const CONNECTS = "const net = require('node:net'); require('node:fs').writeFileSync(process.argv[2], String(process.pid)); net.connect(process.argv[1]); setInterval(() => undefined, 1000);";

let folder: string;
let path: string;
let server: Server;
let connections: Socket[];
let children: ChildProcess[];
let shipId: ShipId;

beforeEach(async () => {
  // Short, under /tmp: a Unix socket path is at most 104 bytes on macOS.
  folder = mkdtempSync('/tmp/aeolus-peer-');
  path = join(folder, 'fleet.sock');
  connections = [];
  children = [];
  shipId = newId('ship');
  server = createServer((connection) => connections.push(connection));
  await new Promise<void>((resolve) => server.listen(path, resolve));
});

afterEach(async () => {
  for (const child of children) {
    child.kill('SIGKILL');
  }
  for (const pidFile of ['outside.pid', 'session.pid', 'session-child.pid']) {
    try {
      process.kill(Number(readFileSync(join(folder, pidFile), 'utf8')), 'SIGKILL');
    } catch {
      // Never started, or already gone.
    }
  }
  for (const connection of connections) {
    connection.destroy();
  }
  await new Promise((resolve) => server.close(resolve));
  rmSync(folder, { recursive: true, force: true });
});

async function theConnection(): Promise<Socket> {
  await expect.poll(() => connections.length, { timeout: 5000 }).toBeGreaterThan(0);
  const [connection] = connections;
  if (connection === undefined) {
    throw new Error('nothing connected');
  }
  return connection;
}

async function pidIn(file: string): Promise<number> {
  await expect.poll(() => { try { return readFileSync(join(folder, file), 'utf8'); } catch { return ''; } }, { timeout: 5000 }).not.toBe('');
  return Number(readFileSync(join(folder, file), 'utf8'));
}

/** A child of this process, as the trierarch's own aeolus-push.sh is. */
function aChild(): void {
  children.push(spawn(NODE, ['-e', CONNECTS, path, join(folder, 'child.pid')], { stdio: 'ignore' }));
}

/**
 * A process outside this one's tree, as another ship's session is: started by
 * a shell that ends at once, so it has another parent. Under a root when one is
 * named: a shell that writes its own pid there and runs the process as its child.
 */
function aDetached(pidFile: string, within: { root?: string } = {}): void {
  const connects = '"$0" -e "$1" "$2" "$3"';
  const script = within.root === undefined ? `${connects} &` : `sh -c 'echo $$ > "$4"; ${connects}' "$0" "$1" "$2" "$3" "$4" &`;
  spawn('sh', ['-c', script, NODE, CONNECTS, path, join(folder, pidFile), join(folder, within.root ?? 'no-root.pid')], { stdio: 'ignore' }).unref();
}

const canResolvePeers = process.platform === 'linux' || process.platform === 'darwin';

describe.runIf(canResolvePeers)(`the caller check of a ship's socket on this machine (${process.platform})`, () => {
  it("lets the trierarch's own processes call", async () => {
    const mayCall = createCallerCheck({ platform: process.platform, sessionRootOf: () => Promise.resolve(undefined) });
    aChild();

    await expect(mayCall(shipId, await theConnection())).resolves.toBe(true);
  });

  it("refuses a process outside the ship's session and the trierarch", async () => {
    const mayCall = createCallerCheck({ platform: process.platform, sessionRootOf: () => Promise.resolve(undefined) });
    aDetached('outside.pid');

    await expect(mayCall(shipId, await theConnection())).resolves.toBe(false);
  });

  it("lets a process of the ship's own session call, under its session's root", async () => {
    aDetached('session-child.pid', { root: 'session.pid' });
    const root = await pidIn('session.pid');
    const mayCall = createCallerCheck({ platform: process.platform, sessionRootOf: (ship) => Promise.resolve(ship === shipId ? root : undefined) });

    await expect(mayCall(shipId, await theConnection())).resolves.toBe(true);
  });

  it("refuses a process of another ship's session", async () => {
    aDetached('session-child.pid', { root: 'session.pid' });
    const root = await pidIn('session.pid');
    const mayCall = createCallerCheck({ platform: process.platform, sessionRootOf: (ship) => Promise.resolve(ship === shipId ? undefined : root) });

    await expect(mayCall(shipId, await theConnection())).resolves.toBe(false);
  });

  it('refuses a connection whose other end is gone', async () => {
    const mayCall = createCallerCheck({ platform: process.platform, sessionRootOf: () => Promise.resolve(undefined) });
    aChild();
    const connection = await theConnection();
    for (const child of children) {
      child.kill('SIGKILL');
    }
    await wait(200);

    await expect(mayCall(shipId, connection)).resolves.toBe(false);
  });
});

describe('the caller check where no peer resolves', () => {
  it('refuses every call, never allows', async () => {
    const mayCall = createCallerCheck({ platform: 'freebsd', sessionRootOf: () => Promise.resolve(process.pid) });
    aChild();

    await expect(mayCall(shipId, await theConnection())).resolves.toBe(false);
  });
});

/** A process as macOS's ps shows it: its parent and its process group; its session ps shows as 0, as macOS hides it. */
interface ShownProcess {
  readonly parent: number;
  readonly group: number;
}

/** The descriptor of this end of the connection, as lsof lists it. */
function descriptorOfConnection(connection: Socket): number {
  const handle: unknown = Reflect.get(connection, '_handle');
  const fd: unknown = typeof handle === 'object' && handle !== null ? Reflect.get(handle, 'fd') : undefined;
  if (typeof fd !== 'number') {
    throw new Error('the connection has no descriptor');
  }
  return fd;
}

/**
 * macOS's lsof and ps as the caller check reads them: this process holds one
 * end of the connection, the caller the other, and every process in the table
 * answers its parent, its group and a session of 0.
 */
function macOs(at: { fd: number; caller: number; table: ReadonlyMap<number, ShownProcess> }): (command: string, options: { args: readonly string[] }) => Promise<CommandResult> {
  return (command, { args }) => {
    if (command === 'lsof') {
      const listed = [`p${String(process.pid)}`, `f${String(at.fd)}`, 'd0xa1', 'n->0xb2', `p${String(at.caller)}`, 'f5', 'd0xb2', 'n->0xa1'].join('\n');
      return Promise.resolve({ status: 0, stdout: `${listed}\n`, stderr: '' });
    }
    const [, keyword, , pid] = args;
    const shown = at.table.get(Number(pid));
    if (command !== 'ps' || shown === undefined) {
      return Promise.resolve({ status: 1, stdout: '', stderr: '' });
    }
    const value = keyword === 'ppid=' ? shown.parent : keyword === 'pgid=' ? shown.group : 0;
    return Promise.resolve({ status: 0, stdout: `${String(value)}\n`, stderr: '' });
  };
}

describe("the caller check of a hold's socket on macOS, as its ps and lsof show the processes", () => {
  const hold = 5000;
  const harness = 5001;
  const reparented = 5002;

  it("refuses a process another ship's session forked once it is reparented, by the harness's process group it stays in (#196)", async () => {
    aChild();
    const fd = descriptorOfConnection(await theConnection());
    // The hold started the harness detached, so the harness leads a group of its own; the process it forked was reparented to launchd and stays in that group.
    const table = new Map<number, ShownProcess>([
      [hold, { parent: 1, group: hold }],
      [harness, { parent: hold, group: harness }],
      [reparented, { parent: 1, group: harness }],
    ]);
    const mayCall = createTrierarchCallerCheck({ platform: 'darwin', sessionRoots: () => Promise.resolve([hold]), harnessSessions: () => Promise.resolve([harness]), run: macOs({ fd, caller: reparented, table }) });

    await expect(mayCall(await theConnection())).resolves.toBe(false);
  });

  it("refuses a process a turn of another ship's session forked once that turn's harness has ended and it is reparented, by the group of the harness the hold started (#208)", async () => {
    aChild();
    const fd = descriptorOfConnection(await theConnection());
    // The turn's harness led the group and is gone; the process it forked stays in that group under launchd.
    const table = new Map<number, ShownProcess>([
      [hold, { parent: 1, group: hold }],
      [reparented, { parent: 1, group: harness }],
    ]);
    const mayCall = createTrierarchCallerCheck({ platform: 'darwin', sessionRoots: () => Promise.resolve([hold]), harnessSessions: () => Promise.resolve([harness]), run: macOs({ fd, caller: reparented, table }) });

    await expect(mayCall(await theConnection())).resolves.toBe(false);
  });

  it('lets the trierarch call from a group whose pid a harness the hold started once had, as a pid is used again once its group is gone', async () => {
    aChild();
    const fd = descriptorOfConnection(await theConnection());
    const table = new Map<number, ShownProcess>([
      [hold, { parent: 1, group: hold }],
      [harness, { parent: 1, group: harness }],
    ]);
    const mayCall = createTrierarchCallerCheck({ platform: 'darwin', sessionRoots: () => Promise.resolve([hold]), harnessSessions: () => Promise.resolve([harness]), run: macOs({ fd, caller: harness, table }) });

    await expect(mayCall(await theConnection())).resolves.toBe(true);
  });

  it('lets the trierarch call, in a process group of its own', async () => {
    aChild();
    const fd = descriptorOfConnection(await theConnection());
    const trierarch = 6000;
    const table = new Map<number, ShownProcess>([
      [hold, { parent: 1, group: hold }],
      [harness, { parent: hold, group: harness }],
      [trierarch, { parent: 1, group: trierarch }],
    ]);
    const mayCall = createTrierarchCallerCheck({ platform: 'darwin', sessionRoots: () => Promise.resolve([hold]), harnessSessions: () => Promise.resolve([harness]), run: macOs({ fd, caller: trierarch, table }) });

    await expect(mayCall(await theConnection())).resolves.toBe(true);
  });
});
