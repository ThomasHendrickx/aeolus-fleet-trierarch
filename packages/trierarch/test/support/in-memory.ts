import { createIdGenerator, CREW_REQUEST_REASON_MAX_LENGTH, type ClearOutcome, type CrewStatus, type ShipId, type TrierarchConfiguration, type TrierarchWorkspace } from '@aeolus-fleet/common';

import { EMPTY_STATE, type TrierarchState } from '../../src/core/entry.js';
import { createHandleDelivery } from '../../src/core/handle-delivery.js';
import type {
  ArgoReport,
  AssignedRequest,
  Detected,
  Delivery,
  FleetPort,
  FleetShipStatus,
  GiveBackAnswer,
  HarnessPort,
  LaunchSeen,
  Identity,
  InboxAnswer,
  LoggedAction,
  ObservedSession,
  ObservedWorktree,
  ProcessPort,
  SelfReport,
  StatePort,
  TrustedPlaces,
  TrustPort,
  Turn,
  WorkspacePort,
  WrittenStatus,
} from '../../src/core/ports.js';
import { createReportSelf } from '../../src/core/report-self.js';
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

/** A crew request assigned to this trierarch, as the fleet holds it. */
interface HeldRequest {
  settings: unknown;
  settingsVersion: number;
  status: CrewStatus | null;
}

/** The settings most tests request: a worktree of aeolus-fleet on Claude Code. */
export function crewSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { harness: 'claude-code', workspace: { kind: 'worktree', repository: 'aeolus-fleet' }, options: {}, ...overrides };
}

export class InMemoryFleet implements FleetPort {
  readonly url = 'https://fleet.example.com';
  readonly ships = new Map<ShipId, FleetShip>();
  /** The crew requests assigned to this trierarch, by ship, oldest first. */
  readonly requests = new Map<ShipId, HeldRequest>();
  /** Every status the trierarch wrote, in order, with the attempt and session start it wrote with it. */
  readonly statuses: ({ shipId: ShipId } & WrittenStatus)[] = [];
  /** The ships whose release the trierarch confirmed. */
  readonly confirmed: ShipId[] = [];
  /** The pending clear requests to this trierarch, oldest first (decision 0032). */
  readonly clearRequests: { shipId: ShipId; repository: string }[] = [];
  /** Every clear request the trierarch confirmed, and how. */
  readonly cleared: { shipId: ShipId; repository: string; outcome: ClearOutcome }[] = [];
  /** What the trierarch sent argo, once per idempotency key. */
  readonly toArgo: ArgoReport[] = [];
  readonly acked: string[] = [];
  readonly pongs: string[] = [];
  readonly reports: { crewToken: string; state: string; note: string }[] = [];
  /** What the trierarch reported of itself, as its own ship. */
  readonly selfReports: SelfReport[] = [];
  /** The crew requests the trierarch gave back, with the settings version it tried and its reason (#382). */
  readonly givenBack: { shipId: ShipId; settingsVersion: number; reason: string }[] = [];
  /** The trierarch's own ship, as whoami answers it: its name names the machine. */
  readonly self = { shipId: newId('ship'), name: 'mac-studio' };
  /** Set to lose the next register's reply: the fleet crews the ship, the trierarch never hears. */
  isLosingRegisterReply = false;
  /** Set to make the fleet refuse every give-back as final, as when the crew turned final in between. */
  isRefusingGiveBack = false;
  private count = 0;

  /** The ship's crew request, assigned to this trierarch, as a requester asks and the trierarch plugin assigns it. */
  request(shipId: ShipId, settings: unknown = crewSettings()): void {
    this.requests.set(shipId, { settings, settingsVersion: 1, status: null });
  }

  /** The request written again, as Restart (the same settings) or Edit (new ones) does: a new settings version. */
  requestAgain(shipId: ShipId, settings?: unknown): void {
    const held = this.requestOf(shipId);
    this.requests.set(shipId, { ...held, settings: settings ?? held.settings, settingsVersion: held.settingsVersion + 1 });
  }

  /** The crew's status as the fleet holds it, as one another pass of this trierarch wrote before its state was lost. */
  holdStatus(shipId: ShipId, status: CrewStatus): void {
    this.requestOf(shipId).status = status;
  }

  /**
   * Gives a request back as the fleet does (#382): only while its crew is not
   * final and for its current settings version, with a reason of one line of
   * at most 200 characters. It is no longer assigned here, and the ship's
   * lease ends. A repeat for the same version is an OK.
   */
  giveBack(shipId: ShipId, given: { settingsVersion: number; reason: string }): Promise<GiveBackAnswer> {
    const refused = (code: string): Promise<GiveBackAnswer> => Promise.resolve({ kind: 'refused', code, message: `the fleet refused: ${code}` });
    const held = this.requests.get(shipId);
    if (held === undefined) {
      return this.givenBack.some((each) => each.shipId === shipId && each.settingsVersion === given.settingsVersion) ? Promise.resolve({ kind: 'givenBack' }) : refused('NOT_FOUND');
    }
    if (this.isRefusingGiveBack || held.status === 'running' || held.status === 'restarting' || held.status === 'crashed') {
      return refused('CREW_REQUEST_FINAL');
    }
    if (held.status === 'releasing') {
      return refused('CREW_REQUEST_RELEASING');
    }
    if (held.settingsVersion !== given.settingsVersion) {
      return refused('CREW_REQUEST_SETTINGS_CHANGED');
    }
    if (given.reason.length > CREW_REQUEST_REASON_MAX_LENGTH || given.reason.includes('\n')) {
      return refused('INVALID_CREW_REQUEST_REASON');
    }
    this.requests.delete(shipId);
    this.givenBack.push({ shipId, ...given });
    const ship = this.shipOf(shipId);
    if (ship.status === 'crewed') {
      ship.status = 'awaitingCrew';
      delete ship.crewToken;
    }
    return Promise.resolve({ kind: 'givenBack' });
  }

  whoami(): Promise<{ shipId: ShipId; name: string }> {
    return Promise.resolve(this.self);
  }

  /** The requester removes the request: it is marked releasing, as it is assigned. */
  removeRequest(shipId: ShipId): void {
    this.requestOf(shipId).status = 'releasing';
  }

  /** The request is no longer assigned to this trierarch, as when its ship is retired. */
  unassign(shipId: ShipId): void {
    this.requests.delete(shipId);
  }

  requestOf(shipId: ShipId): HeldRequest {
    const held = this.requests.get(shipId);
    if (held === undefined) {
      throw new Error(`no request for ${shipId}`);
    }
    return held;
  }

  assignedRequests(): Promise<readonly AssignedRequest[]> {
    return Promise.resolve([...this.requests].map(([shipId, { settings, settingsVersion, status }]) => ({ shipId, settings, settingsVersion, status })));
  }

  writeStatus(shipId: ShipId, written: WrittenStatus): Promise<void> {
    const held = this.requestOf(shipId);
    const { status } = written;
    if (held.status === 'releasing' && status !== 'releasing') {
      return Promise.reject(new Error('CREW_REQUEST_RELEASING'));
    }
    const last = this.statuses.findLast((each) => each.shipId === shipId);
    const isSame = held.status === status && last?.attempt === written.attempt && last.startedAt?.getTime() === written.startedAt?.getTime();
    if (!isSame) {
      held.status = status;
      this.statuses.push({ shipId, ...written });
    }
    return Promise.resolve();
  }

  confirmRelease(shipId: ShipId): Promise<void> {
    if (this.requestOf(shipId).status !== 'releasing') {
      return Promise.reject(new Error('CREW_REQUEST_NOT_RELEASING'));
    }
    this.requests.delete(shipId);
    this.confirmed.push(shipId);
    return Promise.resolve();
  }

  /** A ship with fleet:manage asks this trierarch to clear the worktree it kept; asking again changes nothing. */
  clearWorktree(worktree: { shipId: ShipId; repository: string }): void {
    if (!this.clearRequests.some((each) => each.shipId === worktree.shipId && each.repository === worktree.repository)) {
      this.clearRequests.push({ ...worktree });
    }
  }

  pendingClears(): Promise<readonly { shipId: ShipId; repository: string }[]> {
    return Promise.resolve(this.clearRequests.map((each) => ({ ...each })));
  }

  confirmCleared(cleared: { shipId: ShipId; repository: string; outcome: ClearOutcome }): Promise<void> {
    const index = this.clearRequests.findIndex((each) => each.shipId === cleared.shipId && each.repository === cleared.repository);
    if (index === -1) {
      return Promise.reject(new Error('CLEAR_REQUEST_NOT_FOUND'));
    }
    this.clearRequests.splice(index, 1);
    this.cleared.push({ ...cleared });
    return Promise.resolve();
  }

  reportToArgo(report: ArgoReport): Promise<void> {
    if (!this.toArgo.some((each) => each.idempotencyKey === report.idempotencyKey)) {
      this.toArgo.push(report);
    }
    return Promise.resolve();
  }

  pong(deliveryId: string): Promise<void> {
    this.pongs.push(deliveryId);
    return Promise.resolve();
  }

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

  reportSelf(report: SelfReport): Promise<void> {
    this.selfReports.push(structuredClone(report));
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
  /** What each ship's session shows in its launch window: activity unless a test sets otherwise. */
  readonly seen = new Map<ShipId, LaunchSeen>();
  /** Each screen it was asked to read, with the model the session launched with. */
  readonly asked: { shipId: ShipId; model?: string }[] = [];
  /** Set to make every launch fail, as when the harness's CLI cannot start: the entry stays crewing. */
  isFailingLaunch = false;

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
    if (this.isFailingLaunch) {
      return Promise.reject(new Error(`the harness could not start ${session.shipId}`));
    }
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

  launchSeen(session: { shipId: ShipId; model?: string }): Promise<LaunchSeen> {
    this.asked.push(session);
    return Promise.resolve(this.seen.get(session.shipId) ?? { kind: 'active' });
  }
}

export class InMemoryWorkspace implements WorkspacePort {
  /** Folders on disk, with whether they hold changes, and what removing one would discard, as git says it. */
  readonly folders = new Map<string, { shipId?: ShipId; hasChanges: boolean; unsaved: string[] }>([[NOTES_FOLDER, { hasChanges: false, unsaved: [] }]]);

  prepare(at: { shipId: ShipId; shipName: string; workspace: TrierarchWorkspace }): Promise<{ folder: string }> {
    const { shipId, shipName, workspace } = at;
    const folder = workspace.kind === 'folder' ? NOTES_FOLDER : `${WORKTREE_ROOT}/${workspace.repository}/${shipName}`;
    if (!this.folders.has(folder)) {
      this.folders.set(folder, { shipId, hasChanges: false, unsaved: [] });
    }
    return Promise.resolve({ folder });
  }

  isClean(folder: string): Promise<boolean> {
    return Promise.resolve(this.folders.get(folder)?.hasChanges !== true);
  }

  unsaved(folder: string): Promise<readonly string[]> {
    return Promise.resolve([...(this.folders.get(folder)?.unsaved ?? [])]);
  }

  /** Set to make every remove fail, as when git refuses. */
  isFailingRemove = false;

  remove(folder: string): Promise<void> {
    if (this.isFailingRemove) {
      return Promise.reject(new Error(`git worktree remove ${folder} failed`));
    }
    this.folders.delete(folder);
    return Promise.resolve();
  }

  worktrees(): Promise<readonly ObservedWorktree[]> {
    return Promise.resolve(
      [...this.folders]
        .filter(([path]) => path.startsWith(`${WORKTREE_ROOT}/`))
        .map(([path, { shipId }]) => {
          const [repository = '', name = ''] = path.slice(WORKTREE_ROOT.length + 1).split('/');
          return { path, repository, name, ...(shipId !== undefined && { shipId }) };
        }),
    );
  }

  /** Someone changes a file in the folder, as git status shows the change. */
  change(folder: string, status = ' M README.md'): void {
    const found = this.folders.get(folder);
    if (found !== undefined) {
      found.hasChanges = true;
      found.unsaved.push(status);
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
  readonly actions: LoggedAction[] = [];

  warn(message: string): void {
    this.warnings.push(message);
  }

  action(logged: LoggedAction): void {
    this.actions.push(logged);
  }
}

/** What each harness trusts, as Claude Code's and Codex's own files say: every configured place, until a test takes one away. */
export class InMemoryTrust implements TrustPort {
  private readonly untrusted = new Set<string>();
  constructor(private readonly configuration: TrierarchConfiguration) {}

  untrust(harness: string, place: { kind: 'repository' | 'folder'; name: string }): void {
    this.untrusted.add(`${harness} ${place.kind} ${place.name}`);
  }

  trusted(): Promise<TrustedPlaces> {
    const isTrusted = (harness: string, kind: 'repository' | 'folder') => (name: string) => !this.untrusted.has(`${harness} ${kind} ${name}`);
    return Promise.resolve(
      Object.fromEntries(
        Object.keys(this.configuration.harnesses).map((harness) => [
          harness,
          { repositories: Object.keys(this.configuration.repositories).filter(isTrusted(harness, 'repository')), folders: Object.keys(this.configuration.folders).filter(isTrusted(harness, 'folder')) },
        ]),
      ),
    );
  }
}

/** A trierarch on in-memory ports. */
export function aTrierarch(configuration: TrierarchConfiguration = CONFIGURATION, detected: Detected = {}) {
  const state = new InMemoryState();
  const fleet = new InMemoryFleet();
  const processes = new InMemoryProcesses();
  const harness = new InMemoryHarness(processes);
  // Each harness keeps its own identities, as the aeolus plugin does per harness.
  const codex = new InMemoryHarness(processes);
  const workspace = new InMemoryWorkspace();
  const trust = new InMemoryTrust(configuration);
  const clock = new TestClock();
  const logger = new CollectingLogger();
  const setup = {
    configuration,
    version: '0.1.0',
    adapterFlags: { 'claude-code': [{ flag: '--continue', when: 'restart' as const }], codex: [{ flag: '--no-daemon', when: 'always' as const }] },
    riskyFlags: { 'claude-code': ['--dangerously-skip-permissions'], codex: ['--dangerously-bypass-approvals-and-sandbox'] },
    machine: { os: 'macos' as const, arch: 'arm64' as const },
    detected,
  };
  const handle = createHandleDelivery({ fleet, logger });
  /** The models sessions refused, as the trierarch kept them. */
  const refusals: { harness: string; id: string; at: Date }[] = [];
  const refuseModel = (refused: { harness: string; id: string; at: Date }): Promise<void> => {
    refusals.push(refused);
    return Promise.resolve();
  };
  const pass = createRunPass({ fleet, harnesses: { 'claude-code': harness, codex }, processes, workspace, trust, state, setup, clock, logger, refuseModel });
  const uninstall = createUninstall({ processes, state });
  const reportSelf = createReportSelf({ fleet, processes, trust, state, setup });

  /** A message arrives at the trierarch's own ship: its delivery, handled. */
  async function deliver(message: { contentType: string; payload: string }): Promise<Delivery> {
    const delivery: Delivery = { deliveryId: newId('delivery'), messageId: newId('message'), senderShipId: newId('ship'), ...message };
    await handle(delivery);
    return delivery;
  }

  return { fleet, processes, harness, codex, workspace, trust, state, clock, logger, handle, pass, uninstall, reportSelf, deliver, refusals };
}

export type Trierarch = ReturnType<typeof aTrierarch>;

