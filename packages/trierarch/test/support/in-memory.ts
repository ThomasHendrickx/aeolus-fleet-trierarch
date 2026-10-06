import { createIdGenerator, type ShipId, type TrierarchConfiguration, type TrierarchWorkspace } from '@aeolus-fleet/common';

import { EMPTY_STATE, type Outgoing, type TrierarchState } from '../../src/core/entry.js';
import { createHandleDelivery } from '../../src/core/handle-delivery.js';
import type {
  Delivery,
  FleetPort,
  FleetShipStatus,
  HarnessPort,
  Identity,
  InboxAnswer,
  ObservedSession,
  ObservedWorktree,
  ProcessPort,
  StatePort,
  Turn,
  WorkspacePort,
} from '../../src/core/ports.js';
import { createRunPass } from '../../src/core/run-pass.js';
import { createUninstall } from '../../src/core/uninstall.js';

/**
 * Hand-written in-memory ports for the trierarch's core, behaving as the
 * fleet, tmux, git and the aeolus plugin do, so tests assert outcomes and
 * stored state, never calls.
 */

export const newId = createIdGenerator();
export const WORKTREE_ROOT = '/home/thomas/.aeolus/trierarch/worktrees';
export const NOTES_FOLDER = '/home/thomas/notes';

export const CONFIGURATION: TrierarchConfiguration = {
  caps: { ships: 8, running: 4 },
  repositories: { 'aeolus-fleet': { path: '/home/thomas/Projects/aeolus-fleet' } },
  folders: { notes: { path: NOTES_FOLDER } },
  harnesses: {
    'claude-code': {
      flags: ['--remote-control'],
      options: { model: { values: { opus: ['--model', 'claude-opus-5-5'], sonnet: ['--model', 'claude-sonnet-5-5'] }, default: 'opus' } },
    },
  },
};

interface FleetShip {
  name: string;
  status: 'awaitingCrew' | 'crewed' | 'retired';
  secret?: string;
  crewToken?: string;
  waiting: number;
}

export class InMemoryFleet implements FleetPort {
  readonly url = 'https://fleet.example.com';
  readonly ships = new Map<ShipId, FleetShip>();
  readonly sent: Outgoing[] = [];
  readonly acked: string[] = [];
  readonly reports: { crewToken: string; state: string; note: string }[] = [];
  /** The state saved when each delivery was acknowledged. */
  readonly stateAtAck = new Map<string, TrierarchState | undefined>();
  /** Set to lose the next register's reply: the fleet crews the ship, the trierarch never hears. */
  isLosingRegisterReply = false;
  private count = 0;

  constructor(private readonly store: InMemoryState) {}

  /** A ship of the fleet awaiting crew, as a requester commissions it. */
  commission(name: string): ShipId {
    const shipId = newId('ship');
    this.ships.set(shipId, { name, status: 'awaitingCrew', waiting: 0 });
    return shipId;
  }

  /** Another session crews the ship, as a crew line pasted elsewhere does. */
  crewElsewhere(shipId: ShipId): void {
    this.shipOf(shipId).status = 'crewed';
    this.shipOf(shipId).crewToken = 'aeolus_ct_v1_elsewhere';
  }

  ship(shipId: ShipId): Promise<FleetShipStatus> {
    const ship = this.ships.get(shipId);
    if (ship === undefined) {
      return Promise.resolve({ kind: 'notFound' });
    }
    return Promise.resolve(ship.status === 'retired' ? { kind: 'retired' } : { kind: ship.status, name: ship.name });
  }

  getStartingPrompt(shipId: ShipId): Promise<{ secret: string }> {
    const ship = this.shipOf(shipId);
    if (ship.status !== 'awaitingCrew') {
      return Promise.reject(new Error('SHIP_NOT_AWAITING_CREW'));
    }
    this.count += 1;
    ship.secret = `aeolus_sk_v1_${String(this.count)}`;
    return Promise.resolve({ secret: ship.secret });
  }

  register(crew: { shipId: ShipId; secret: string }): Promise<{ crewToken: string }> {
    const ship = this.shipOf(crew.shipId);
    if (ship.status !== 'awaitingCrew' || ship.secret !== crew.secret) {
      return Promise.reject(new Error('CONFLICT'));
    }
    this.count += 1;
    ship.status = 'crewed';
    ship.crewToken = `aeolus_ct_v1_${String(this.count)}`;
    if (this.isLosingRegisterReply) {
      this.isLosingRegisterReply = false;
      return Promise.reject(new Error('the register reply was lost'));
    }
    return Promise.resolve({ crewToken: ship.crewToken });
  }

  release(shipId: ShipId): Promise<void> {
    const ship = this.shipOf(shipId);
    ship.status = 'awaitingCrew';
    delete ship.crewToken;
    return Promise.resolve();
  }

  /** Releases the ship elsewhere, as the console does. */
  releaseElsewhere(shipId: ShipId): void {
    void this.release(shipId);
  }

  retire(shipId: ShipId): void {
    const ship = this.shipOf(shipId);
    ship.status = 'retired';
    delete ship.crewToken;
  }

  ack(deliveryId: string): Promise<void> {
    this.acked.push(deliveryId);
    this.stateAtAck.set(deliveryId, this.store.saved.at(-1));
    return Promise.resolve();
  }

  send(message: Outgoing): Promise<void> {
    if (!this.sent.some((each) => each.idempotencyKey === message.idempotencyKey)) {
      this.sent.push(message);
    }
    return Promise.resolve();
  }

  inbox(crewToken: string): Promise<InboxAnswer> {
    const ship = [...this.ships.values()].find((each) => each.crewToken === crewToken);
    return Promise.resolve(ship === undefined ? { kind: 'leaseEnded' } : { kind: 'waiting', count: ship.waiting });
  }

  report(crew: { crewToken: string; state: 'blocked' | 'working'; note: string }): Promise<void> {
    this.reports.push(crew);
    return Promise.resolve();
  }

  /** Messages wait for the ship. */
  deliver(shipId: ShipId, count: number): void {
    this.shipOf(shipId).waiting = count;
  }

  shipOf(shipId: ShipId): FleetShip {
    const ship = this.ships.get(shipId);
    if (ship === undefined) {
      throw new Error(`no ship ${shipId}`);
    }
    return ship;
  }

  /** What was sent to a ship, by protocol name. */
  sentTo(shipId: ShipId, name: string): Outgoing[] {
    return this.sent.filter((message) => message.to === shipId && message.name === name);
  }
}

export class InMemoryProcesses implements ProcessPort {
  readonly sessions = new Map<ShipId, ObservedSession['status']>();

  list(): Promise<readonly ObservedSession[]> {
    return Promise.resolve([...this.sessions].map(([shipId, status]) => ({ shipId, status })));
  }

  stop(shipId: ShipId): Promise<void> {
    this.sessions.delete(shipId);
    return Promise.resolve();
  }

  /** The session's process dies; tmux keeps the pane, so the exit is seen. */
  exit(shipId: ShipId): void {
    this.sessions.set(shipId, 'exited');
  }

  /** The machine restarts: every session is gone. */
  restartMachine(): void {
    this.sessions.clear();
  }
}

export class InMemoryHarness implements HarnessPort {
  readonly identities = new Map<string, Identity>();
  readonly launches: { shipId: ShipId; shipName: string; folder: string; workspace: TrierarchWorkspace; isFirstStart: boolean; firstPrompt?: string }[] = [];
  readonly wakes: ShipId[] = [];
  readonly turns = new Map<string, Turn>();

  constructor(private readonly processes: InMemoryProcesses) {}

  prepareIdentity(at: { folder: string; identity: Identity }): Promise<void> {
    this.identities.set(at.folder, at.identity);
    return Promise.resolve();
  }

  crewTokenOf(folder: string): Promise<string | undefined> {
    return Promise.resolve(this.identities.get(folder)?.crewToken);
  }

  removeIdentity(folder: string): Promise<void> {
    this.identities.delete(folder);
    return Promise.resolve();
  }

  launch(session: { shipId: ShipId; shipName: string; folder: string; workspace: TrierarchWorkspace; isFirstStart: boolean; firstPrompt?: string }): Promise<void> {
    const { shipId, shipName, folder, workspace, isFirstStart, firstPrompt } = session;
    this.launches.push({ shipId, shipName, folder, workspace, isFirstStart, ...(firstPrompt !== undefined && { firstPrompt }) });
    this.processes.sessions.set(shipId, 'running');
    return Promise.resolve();
  }

  turnOf(folder: string): Promise<Turn> {
    return Promise.resolve(this.turns.get(folder) ?? 'unknown');
  }

  wake(session: { shipId: ShipId }): Promise<void> {
    this.wakes.push(session.shipId);
    return Promise.resolve();
  }
}

export class InMemoryWorkspace implements WorkspacePort {
  /** Folders on disk, with whether they hold changes. */
  readonly folders = new Map<string, { shipId?: ShipId; hasChanges: boolean }>([[NOTES_FOLDER, { hasChanges: false }]]);

  prepare(at: { shipId: ShipId; shipName: string; workspace: TrierarchWorkspace }): Promise<{ folder: string }> {
    const { shipId, shipName, workspace } = at;
    const folder = workspace.kind === 'folder' ? NOTES_FOLDER : `${WORKTREE_ROOT}/${workspace.repository}/${shipName}`;
    if (!this.folders.has(folder)) {
      this.folders.set(folder, { shipId, hasChanges: false });
    }
    return Promise.resolve({ folder });
  }

  isClean(folder: string): Promise<boolean> {
    return Promise.resolve(this.folders.get(folder)?.hasChanges !== true);
  }

  remove(folder: string): Promise<void> {
    this.folders.delete(folder);
    return Promise.resolve();
  }

  worktrees(): Promise<readonly ObservedWorktree[]> {
    return Promise.resolve(
      [...this.folders]
        .filter(([path]) => path.startsWith(`${WORKTREE_ROOT}/`))
        .map(([path, { shipId }]) => ({ path, ...(shipId !== undefined && { shipId }) })),
    );
  }

  /** Someone changes a file in the folder. */
  change(folder: string): void {
    const found = this.folders.get(folder);
    if (found !== undefined) {
      found.hasChanges = true;
    }
  }
}

export class InMemoryState implements StatePort {
  readonly saved: TrierarchState[] = [];

  load(): Promise<TrierarchState> {
    return Promise.resolve(this.saved.at(-1) ?? EMPTY_STATE);
  }

  save(state: TrierarchState): Promise<void> {
    this.saved.push(structuredClone(state));
    return Promise.resolve();
  }

  current(): TrierarchState {
    return this.saved.at(-1) ?? EMPTY_STATE;
  }
}

export class TestClock {
  private time: number;

  constructor(iso = '2026-10-06T08:00:00.000Z') {
    this.time = Date.parse(iso);
  }

  now(): Date {
    return new Date(this.time);
  }

  advance(milliseconds: number): void {
    this.time += milliseconds;
  }
}

export class CollectingLogger {
  readonly warnings: string[] = [];

  warn(message: string): void {
    this.warnings.push(message);
  }
}

/** A trierarch on in-memory ports, with a requester ship that sends it commands. */
export function aTrierarch(configuration: TrierarchConfiguration = CONFIGURATION) {
  const state = new InMemoryState();
  const fleet = new InMemoryFleet(state);
  const processes = new InMemoryProcesses();
  const harness = new InMemoryHarness(processes);
  // Each harness keeps its own identities, as the aeolus plugin does per harness.
  const codex = new InMemoryHarness(processes);
  const workspace = new InMemoryWorkspace();
  const clock = new TestClock();
  const logger = new CollectingLogger();
  const setup = { configuration, version: '0.1.0' };
  const requester = newId('ship');
  const handle = createHandleDelivery({ fleet, workspace, state, setup, clock, logger });
  const pass = createRunPass({ fleet, harnesses: { 'claude-code': harness, codex }, processes, workspace, state, setup, clock, logger });
  const uninstall = createUninstall({ processes, state });

  /** Sends the trierarch a command, as the requester does: its delivery, handled. */
  async function command(name: string, payload: unknown): Promise<Delivery> {
    const delivery: Delivery = {
      deliveryId: newId('delivery'),
      messageId: newId('message'),
      senderShipId: requester,
      contentType: `application/vnd.aeolus.trierarch.${name}+json`,
      payload: JSON.stringify(payload),
    };
    await handle(delivery);
    return delivery;
  }

  return { fleet, processes, harness, codex, workspace, state, clock, logger, requester, handle, pass, uninstall, command };
}

export type Trierarch = ReturnType<typeof aTrierarch>;

/** A want for a worktree of aeolus-fleet, as most tests send it. */
export function aWant(shipId: ShipId, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { shipId, harness: 'claude-code', workspace: { kind: 'worktree', repository: 'aeolus-fleet' }, options: {}, ...overrides };
}
