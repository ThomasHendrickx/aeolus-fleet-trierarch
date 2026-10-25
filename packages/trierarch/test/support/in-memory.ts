import { createIdGenerator, CREW_REQUEST_REASON_MAX_LENGTH, type ClearOutcome, type CrewStatus, type ShipId, type TrierarchWorkspace } from '@aeolus-fleet/common';

import type { TrierarchConfiguration } from '../../src/adapters/files.js';

import { EMPTY_STATE, type TrierarchState } from '../../src/core/entry.js';
import { createHandleDelivery } from '../../src/core/handle-delivery.js';
import type {
  ArgoReport,
  AssignedRequest,
  Checkout,
  CheckoutsPort,
  ContainerHostPort,
  Detected,
  Delivery,
  FleetPort,
  FleetShipStatus,
  FolderProcessesPort,
  GiveBackAnswer,
  HandOver,
  HarnessPort,
  LaunchSeen,
  Identity,
  InboxAnswer,
  LoggedAction,
  ObservedSession,
  ObservedWorktree,
  OwnerReport,
  RefreshedCheckout,
  OwnerReportAnswer,
  RuntimeMode,
  SelfReport,
  SessionRuntime,
  StatePort,
  TrustedPlaces,
  TrustPort,
  Turn,
  WorkspacePort,
  WrittenStatus,
  ShipOwner,
  ShipSocketsPort,
  TrustedRepositoriesPort,
  MachinePort,
  ModelTokens,
  SubscriptionWindow,
  UsagePort,
} from '../../src/core/ports.js';
import type { MachineLoad } from '../../src/core/machine-load.js';
import { createReadLoad } from '../../src/core/read-load.js';
import { createReadUsage } from '../../src/core/read-usage.js';
import { createReportSelf } from '../../src/core/report-self.js';
import { priceTableOf } from '../../src/core/token-cost.js';
import { createRunPass } from '../../src/core/run-pass.js';
import { createUninstall } from '../../src/core/uninstall.js';
import type { TrustedRepository } from '../../src/core/trusted-repositories.js';

/**
 * Hand-written in-memory ports for the trierarch's core, behaving as the
 * fleet, tmux, git and the aeolus-fleet plugin do, so tests assert outcomes and
 * stored state, never calls.
 */

export const newId = createIdGenerator();

/** argo, the owner of every ship a test gives no other. */
export const ARGO: ShipOwner = { shipId: newId('ship'), name: 'argo' };
export const WORKTREE_ROOT = '/home/thomas/.aeolus/trierarch/worktrees';
export const NOTES_FOLDER = '/home/thomas/notes';
export const CHECKOUTS_ROOT = '/home/thomas/.aeolus/trierarch/checkouts';

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
  /** Of those waiting, the forced ones not handed over yet (decision 0040). */
  forced: number;
}

/** A crew request assigned to this trierarch, as the fleet holds it. */
interface HeldRequest {
  settings: unknown;
  settingsVersion: number;
  status: CrewStatus | null;
  /** Kept as the fleet keeps it (decision 0029): set by the first running, restarting or crashed, cleared on every new settings version. */
  isFinal: boolean;
  /** Its ship's owner as the fleet holds it now (decision 0045). */
  owner: ShipOwner;
}

/** The statuses at which the fleet holds a crew final (decision 0029). */
const FINAL_STATUSES: ReadonlySet<CrewStatus> = new Set(['running', 'restarting', 'crashed']);

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
  /** What the trierarch sent a ship's owner other than argo, once per idempotency key (decision 0045). */
  readonly toOwners: OwnerReport[] = [];
  /** The trierarch plugin's ships asked for the trusted repositories, in order (aeolus-fleet#384). */
  readonly askedForTrustedRepositories: ShipId[] = [];
  /** Set to refuse each ask for the trusted repositories, as a fleet that does not answer. */
  isRefusingAsks = false;
  /** Set to make the fleet refuse every send to an owner, as when no rule lets the trierarch reach it. */
  isRefusingOwnerReports = false;
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
    this.requests.set(shipId, { settings, settingsVersion: 1, status: null, isFinal: false, owner: ARGO });
  }

  /** argo gives the ship a new owner, as fleet.setOwner does. */
  own(shipId: ShipId, owner: ShipOwner): void {
    this.requestOf(shipId).owner = owner;
  }

  /** The request written again, as Restart (the same settings) or Edit (new ones) does: a new settings version. */
  requestAgain(shipId: ShipId, settings?: unknown): void {
    const held = this.requestOf(shipId);
    this.requests.set(shipId, { ...held, settings: settings ?? held.settings, settingsVersion: held.settingsVersion + 1, isFinal: false });
  }

  /** The crew's status as the fleet holds it, as one another pass of this trierarch wrote before its state was lost. */
  holdStatus(shipId: ShipId, status: CrewStatus): void {
    const held = this.requestOf(shipId);
    held.status = status;
    held.isFinal ||= FINAL_STATUSES.has(status);
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
    if (this.isRefusingGiveBack || held.isFinal) {
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

  /** Set to make the fleet unreachable: reading the assigned requests fails. */
  isUnreachable = false;

  assignedRequests(): Promise<readonly AssignedRequest[]> {
    if (this.isUnreachable) {
      return Promise.reject(new Error('the fleet cannot be reached'));
    }
    return Promise.resolve([...this.requests].map(([shipId, { settings, settingsVersion, status, isFinal, owner }]) => ({ shipId, settings, settingsVersion, status, isFinal, owner })));
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
      held.isFinal ||= FINAL_STATUSES.has(status);
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

  askForTrustedRepositories(pluginShipId: ShipId): Promise<void> {
    if (this.isRefusingAsks) {
      return Promise.reject(new Error('the fleet refused it'));
    }
    this.askedForTrustedRepositories.push(pluginShipId);
    return Promise.resolve();
  }

  reportToArgo(report: ArgoReport): Promise<void> {
    if (!this.toArgo.some((each) => each.idempotencyKey === report.idempotencyKey)) {
      this.toArgo.push(report);
    }
    return Promise.resolve();
  }

  reportToOwner(report: OwnerReport): Promise<OwnerReportAnswer> {
    if (this.isRefusingOwnerReports) {
      return Promise.resolve({ kind: 'refused', code: 'NOT_REACHABLE', message: 'no rule lets mac-studio reach thomas' });
    }
    if (!this.toOwners.some((each) => each.idempotencyKey === report.idempotencyKey)) {
      this.toOwners.push(report);
    }
    return Promise.resolve({ kind: 'sent' });
  }

  pong(deliveryId: string): Promise<void> {
    this.pongs.push(deliveryId);
    return Promise.resolve();
  }

  /** A ship of the fleet awaiting crew, as a requester commissions it. */
  commission(name: string): ShipId {
    const shipId = newId('ship');
    this.ships.set(shipId, { name, status: 'awaitingCrew', waiting: 0, forced: 0 });
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

  /** The crew token of each inbox call, in order. */
  readonly inboxCalls: string[] = [];

  inbox(crewToken: string): Promise<InboxAnswer> {
    this.inboxCalls.push(crewToken);
    const ship = [...this.ships.values()].find((each) => each.crewToken === crewToken);
    return Promise.resolve(ship === undefined ? { kind: 'leaseEnded' } : { kind: 'waiting', count: ship.waiting, forced: ship.forced });
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

  /** Of the messages waiting for the ship, `count` are forced and not handed over yet (decision 0040). */
  force(shipId: ShipId, count: number): void {
    this.shipOf(shipId).forced = count;
  }

  shipOf(shipId: ShipId): FleetShip {
    const ship = this.ships.get(shipId);
    if (ship === undefined) {
      throw new Error(`no ship ${shipId}`);
    }
    return ship;
  }
}

export class InMemoryProcesses implements Pick<SessionRuntime, 'list' | 'stop'> {
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
  /** The launch id of each launch, in order (#490). */
  readonly launchIds: string[] = [];
  /** The read-only checkouts each launch gave its session, in order (#1182). */
  readonly launchedCheckouts: { shipId: ShipId; checkouts: readonly Checkout[] }[] = [];
  /** Each hand-over the trierarch made, by ship (#756). */
  readonly handOvers: ShipId[] = [];
  /** Each forced hand-over the trierarch made, by ship, and whether it stopped a busy turn for it (decision 0040). */
  readonly forcedOver: { shipId: ShipId; isTurnStopped: boolean }[] = [];
  /** The folders whose store holds a message to hand (#756). */
  readonly holding = new Set<string>();
  /** Each session the store was told died, with how many launches there had been then (#756). */
  readonly died: { shipId: ShipId; launchesBefore: number }[] = [];
  /** Set to make the plugin hand nothing over, as when another ship of its type took the delivery first. */
  isHandingNothing = false;
  readonly turns = new Map<string, Turn>();
  /** What each ship's session shows in its launch window: activity unless a test sets otherwise. */
  readonly seen = new Map<ShipId, LaunchSeen>();
  /** Each launch it was asked about, by its folder and launch id, with the model the session launched with. */
  readonly asked: { shipId: ShipId; folder: string; launchId: string; model?: string }[] = [];
  /** Whether its aeolus-fleet plugin marks launches (#490): set to false for one older than the launch marker. */
  isMarkingLaunches = true;
  /** Set to make every launch fail, as when the harness's CLI cannot start: the entry stays crewing. */
  isFailingLaunch = false;
  /** Set to say why its aeolus-fleet plugin cannot be found, as when its cache folder is empty (#1212): nothing of it can be read. */
  pluginProblem: string | undefined = undefined;
  /** Set to say why no session of the harness can start, as when its aeolus-fleet plugin's scripts are gone (#827). */
  problem: string | undefined = undefined;

  constructor(private readonly processes: InMemoryProcesses) {}

  prepareIdentity(at: { folder: string; identity: Identity; crewToken: string }): Promise<void> {
    this.identities.set(at.folder, at.identity);
    return Promise.resolve();
  }

  hasIdentity(session: { shipId: ShipId; folder: string }): Promise<boolean> {
    if (this.pluginProblem !== undefined) {
      return Promise.reject(new Error(this.pluginProblem));
    }
    return Promise.resolve(this.identities.has(session.folder));
  }

  removeIdentity(session: { shipId: ShipId; folder: string }): Promise<void> {
    this.identities.delete(session.folder);
    return Promise.resolve();
  }

  launch(session: { shipId: ShipId; shipName: string; folder: string; workspace: TrierarchWorkspace; checkouts: readonly Checkout[]; isFirstStart: boolean; launchId: string; firstPrompt?: string }): Promise<void> {
    if (this.isFailingLaunch) {
      return Promise.reject(new Error(`the harness could not start ${session.shipId}`));
    }
    const { shipId, shipName, folder, workspace, checkouts, isFirstStart, launchId, firstPrompt } = session;
    this.launches.push({ shipId, shipName, folder, workspace, isFirstStart, ...(firstPrompt !== undefined && { firstPrompt }) });
    this.launchIds.push(launchId);
    this.launchedCheckouts.push({ shipId, checkouts });
    this.processes.sessions.set(shipId, 'running');
    return Promise.resolve();
  }

  turnOf(session: { shipId: ShipId; folder: string }): Promise<Turn> {
    if (this.pluginProblem !== undefined) {
      return Promise.reject(new Error(this.pluginProblem));
    }
    return Promise.resolve(this.turns.get(session.folder) ?? 'unknown');
  }

  /** As the plugin does: one message handed over, the store keeps it until confirmed, and the turn is busy. */
  handOver(session: { shipId: ShipId; folder: string }): Promise<HandOver> {
    if (this.isHandingNothing) {
      return Promise.resolve('nothing');
    }
    this.handOvers.push(session.shipId);
    this.holding.delete(session.folder);
    this.turns.set(session.folder, 'busy');
    return Promise.resolve('handed');
  }

  /** As the plugin does: the forced message handed over first, a busy turn stopped for it, and the turn busy with it. */
  forceOver(session: { shipId: ShipId; folder: string; isTurnBusy: boolean }): Promise<HandOver> {
    if (this.isHandingNothing) {
      return Promise.resolve('nothing');
    }
    this.forcedOver.push({ shipId: session.shipId, isTurnStopped: session.isTurnBusy });
    this.turns.set(session.folder, 'busy');
    return Promise.resolve('handed');
  }

  isHolding(session: { shipId: ShipId; folder: string }): Promise<boolean> {
    if (this.pluginProblem !== undefined) {
      return Promise.reject(new Error(this.pluginProblem));
    }
    return Promise.resolve(this.holding.has(session.folder));
  }

  sessionDied(session: { shipId: ShipId; folder: string }): Promise<void> {
    this.died.push({ shipId: session.shipId, launchesBefore: this.launches.filter((each) => each.shipId === session.shipId).length });
    return Promise.resolve();
  }

  startProblem(): Promise<string | undefined> {
    return Promise.resolve(this.problem);
  }

  marksLaunches(): Promise<boolean> {
    if (this.pluginProblem !== undefined) {
      return Promise.reject(new Error(this.pluginProblem));
    }
    return Promise.resolve(this.isMarkingLaunches);
  }

  launchSeen(session: { shipId: ShipId; folder: string; launchId: string; model?: string }): Promise<LaunchSeen> {
    if (this.pluginProblem !== undefined) {
      return Promise.reject(new Error(this.pluginProblem));
    }
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

  /** Folders under the root the trierarch did not make, or that git does not know: git cannot read or remove them. */
  readonly notMade = new Set<string>();

  isMade(folder: string): Promise<boolean> {
    return Promise.resolve(!this.notMade.has(folder));
  }

  unsaved(folder: string): Promise<readonly string[]> {
    if (this.notMade.has(folder)) {
      return Promise.reject(new Error(`${folder} is no worktree under ${WORKTREE_ROOT}: the trierarch removes only what it made`));
    }
    return Promise.resolve([...(this.folders.get(folder)?.unsaved ?? [])]);
  }

  /** Set to make every remove fail, as when git refuses. */
  isFailingRemove = false;

  remove(folder: string): Promise<void> {
    if (this.notMade.has(folder)) {
      return Promise.reject(new Error(`${folder} is no worktree under ${WORKTREE_ROOT}: the trierarch removes only what it made`));
    }
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

/** Each ship's read-only checkouts (#1182), as the configuration names them for its working repository, under the checkouts root. */
export class InMemoryCheckouts implements CheckoutsPort {
  readonly made = new Map<ShipId, readonly Checkout[]>();
  /** The ships whose checkouts were removed, in order. */
  readonly removed: ShipId[] = [];

  constructor(private readonly configuration: TrierarchConfiguration) {}

  static pathOf(shipId: ShipId, repository: string): string {
    return `${CHECKOUTS_ROOT}/${shipId}/${repository}`;
  }

  prepare(at: { shipId: ShipId; repository: string }): Promise<readonly Checkout[]> {
    const made = this.made.get(at.shipId) ?? (this.configuration.repositories[at.repository]?.checkouts ?? []).map((repository) => ({ repository, path: InMemoryCheckouts.pathOf(at.shipId, repository) }));
    this.made.set(at.shipId, made);
    return Promise.resolve(made);
  }

  refresh(shipId: ShipId): Promise<readonly RefreshedCheckout[]> {
    return Promise.resolve((this.made.get(shipId) ?? []).map(({ repository }) => ({ repository, revision: `${repository}-main` })));
  }

  remove(shipId: ShipId): Promise<void> {
    if (this.made.delete(shipId)) {
      this.removed.push(shipId);
    }
    return Promise.resolve();
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
  private readonly unaccepted: { harness: string; flag: string }[] = [];
  constructor(private readonly configuration: TrierarchConfiguration) {}

  /** The harness asks again about the flag, as before its question is accepted (#403). */
  unaccept(harness: string, flag: string): void {
    this.unaccepted.push({ harness, flag });
  }

  untrust(harness: string, place: { kind: 'repository' | 'folder'; name: string }): void {
    this.untrusted.add(`${harness} ${place.kind} ${place.name}`);
  }

  trusted(): Promise<TrustedPlaces> {
    const isTrusted = (harness: string, kind: 'repository' | 'folder') => (name: string) => !this.untrusted.has(`${harness} ${kind} ${name}`);
    return Promise.resolve(
      Object.fromEntries(
        Object.keys(this.configuration.harnesses).map((harness) => [
          harness,
          {
            repositories: Object.keys(this.configuration.repositories).filter(isTrusted(harness, 'repository')),
            folders: Object.keys(this.configuration.folders).filter(isTrusted(harness, 'folder')),
            unacceptedFlags: this.unaccepted.filter((each) => each.harness === harness).map((each) => each.flag),
          },
        ]),
      ),
    );
  }
}

/** The ships' sockets (decision 0026): which are open, and at each open whether its ship's session had started yet. */
export class InMemoryShipSockets implements ShipSocketsPort {
  readonly openShips = new Set<ShipId>();
  /** Each open, in order, with how many launches of its ship there had been then. */
  readonly opens: { shipId: ShipId; launchesBefore: number }[] = [];
  constructor(private readonly harnesses: readonly InMemoryHarness[]) {}

  static pathOf(shipId: ShipId): string {
    return `/home/thomas/.aeolus/trierarch/sockets/${shipId}/fleet.sock`;
  }

  open(shipId: ShipId): Promise<string> {
    this.openShips.add(shipId);
    this.opens.push({ shipId, launchesBefore: this.harnesses.flatMap((harness) => harness.launches).filter((launch) => launch.shipId === shipId).length });
    return Promise.resolve(InMemoryShipSockets.pathOf(shipId));
  }

  close(shipId: ShipId): Promise<void> {
    this.openShips.delete(shipId);
    return Promise.resolve();
  }

  /** The trierarch stopped: none of its sockets is open any more. */
  stopTrierarch(): void {
    this.openShips.clear();
  }
}

/** What runs in each folder, as the machine's processes say it: a dev server a session left behind. */
export class InMemoryFolderProcesses implements FolderProcessesPort {
  /** The programs running in each folder. */
  readonly running = new Map<string, string[]>();
  /** Every folder whose processes were stopped, in order. */
  readonly stoppedIn: string[] = [];
  /** Set to make every stop fail, as when a process cannot be signalled. */
  isFailingStop = false;

  start(folder: string, program: string): void {
    this.running.set(folder, [...(this.running.get(folder) ?? []), program]);
  }

  stopIn(folder: string): Promise<number> {
    if (this.isFailingStop) {
      return Promise.reject(new Error(`stopping the processes in ${folder} failed`));
    }
    const stopped = this.running.get(folder)?.length ?? 0;
    this.running.delete(folder);
    this.stoppedIn.push(folder);
    return Promise.resolve(stopped);
  }
}


/** The trierarch plugin's ship, as init kept it from the setup line: the one ship the trusted repositories come from. */
export const PLUGIN_SHIP_ID: ShipId = 'shp_01m3tbfspe96yf1rnr4ank9p1a';

/** The trusted repositories the trierarch accepted, in memory; each accept in order. */
export class InMemoryTrustedRepositories implements TrustedRepositoriesPort {
  readonly accepted: (readonly TrustedRepository[])[] = [];
  private list: readonly TrustedRepository[] = [];

  current(): readonly TrustedRepository[] {
    return this.list;
  }

  accept(list: readonly TrustedRepository[]): Promise<void> {
    this.accepted.push(list);
    this.list = list;
    return Promise.resolve();
  }
}

/** A trierarch on in-memory ports, knowing the trierarch plugin's ship. */
const GIB = 1024 ** 3;

/** A machine of 64 GiB memory, half of it available, 8 cores, and a 1 TB disk half free. */
export function aMachineLoad(overrides: Partial<MachineLoad> = {}): MachineLoad {
  return {
    memory: { totalBytes: 64 * GIB, availableBytes: 32 * GIB },
    swap: { totalBytes: 8 * GIB, usedBytes: 0 },
    cpu: { cores: 8, loadAverage: 1 },
    disk: { totalBytes: 1_000_000_000_000, freeBytes: 500_000_000_000 },
    ...overrides,
  };
}

/** The machine the trierarch runs on, its load as a test sets it. */
export class InMemoryMachine implements MachinePort {
  current: MachineLoad = aMachineLoad();
  /** Set to make reading the load fail, as when the disk cannot be read. */
  isFailing = false;

  load(): Promise<MachineLoad> {
    return this.isFailing ? Promise.reject(new Error('statfs failed')) : Promise.resolve(this.current);
  }
}

/** What the harnesses' own files and CLIs say of their usage: each ship's tokens per model, and each harness's subscription windows, as a test sets them. */
export class InMemoryUsage implements UsagePort {
  readonly tokens = new Map<ShipId, readonly ModelTokens[]>();
  readonly subscriptions = new Map<string, readonly SubscriptionWindow[]>();
  /** Ships whose transcripts cannot be read. */
  readonly unreadable = new Set<ShipId>();

  tokensOf(ship: { shipId: ShipId; harness: string; folder: string }): Promise<readonly ModelTokens[]> {
    return this.unreadable.has(ship.shipId) ? Promise.reject(new Error('EACCES')) : Promise.resolve(this.tokens.get(ship.shipId) ?? []);
  }

  subscriptionOf(harness: string): Promise<readonly SubscriptionWindow[] | undefined> {
    return Promise.resolve(this.subscriptions.get(harness));
  }
}

/** A trierarch on in-memory ports. */
export function aTrierarch(configuration: TrierarchConfiguration = CONFIGURATION, detected: Detected = {}) {
  return trierarchOn({ configuration, detected, pluginShipId: PLUGIN_SHIP_ID });
}

/** A trierarch on in-memory ports on a machine set up before init kept the trierarch plugin's ship (aeolus-fleet#384). */
export function aTrierarchSetUpBefore() {
  return trierarchOn({ configuration: CONFIGURATION, detected: {}, pluginShipId: undefined });
}

function trierarchOn(at: { configuration: TrierarchConfiguration; detected: Detected; pluginShipId: ShipId | undefined }) {
  const { configuration, detected, pluginShipId } = at;
  const state = new InMemoryState();
  const fleet = new InMemoryFleet();
  const processes = new InMemoryProcesses();
  const harness = new InMemoryHarness(processes);
  // Each harness keeps its own identities, as the aeolus-fleet plugin does per harness.
  const codex = new InMemoryHarness(processes);
  const workspace = new InMemoryWorkspace();
  const trust = new InMemoryTrust(configuration);
  const clock = new TestClock();
  const logger = new CollectingLogger();
  const setup = {
    configuration,
    configured: configuration,
    version: '0.1.0',
    adapterFlags: { 'claude-code': [
      { flag: '--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode', when: 'always' as const },
      { flag: '--continue', when: 'restart' as const },
    ], codex: [
      { flag: '--no-daemon', when: 'always' as const },
      { flag: '--config=tools.experimental_request_user_input.enabled=false', when: 'always' as const },
    ] },
    riskyFlags: { 'claude-code': ['--dangerously-skip-permissions'], codex: ['--dangerously-bypass-approvals-and-sandbox'] },
    machine: { os: 'macos' as const, arch: 'arm64' as const },
    detected,
  };
  const trustedRepositories = new InMemoryTrustedRepositories();
  const handle = createHandleDelivery({ fleet, logger, trustedRepositories, ...(pluginShipId !== undefined && { pluginShipId }) });
  /** The models sessions refused, as the trierarch kept them. */
  const refusals: { harness: string; id: string; at: Date }[] = [];
  const refuseModel = (refused: { harness: string; id: string; at: Date }): Promise<void> => {
    refusals.push(refused);
    return Promise.resolve();
  };
  // Launch ids in the order the trierarch asks for them.
  let launches = 0;
  const newLaunchId = (): string => {
    launches += 1;
    return `launch-${String(launches)}`;
  };
  const sockets = new InMemoryShipSockets([harness, codex]);
  const checkouts = new InMemoryCheckouts(configuration);
  const folderProcesses = new InMemoryFolderProcesses();
  const pass = createRunPass({ fleet, harnesses: { 'claude-code': harness, codex }, processes, folderProcesses, workspace, checkouts, trust, state, setup, clock, logger, refuseModel, newLaunchId, sockets });
  const uninstall = createUninstall({ processes, state });
  const machine = new InMemoryMachine();
  const usage = new InMemoryUsage();
  const readLoad = createReadLoad({ machine, fleet, state, clock, logger });
  const readUsage = createReadUsage({ usage, state, clock, logger, harnesses: Object.keys(configuration.harnesses), prices: priceTableOf(undefined) });
  const reportSelf = createReportSelf({ fleet, processes, trust, state, setup, readLoad, readUsage, clock });

  /** A message arrives at the trierarch's own ship: its delivery, handled. */
  async function deliver(message: { contentType: string; payload: string; senderShipId?: ShipId }): Promise<Delivery> {
    const delivery: Delivery = { deliveryId: newId('delivery'), messageId: newId('message'), senderShipId: newId('ship'), ...message };
    await handle(delivery);
    return delivery;
  }

  return { fleet, processes, folderProcesses, harness, codex, workspace, checkouts, trust, state, clock, logger, handle, pass, uninstall, reportSelf, deliver, refusals, sockets, trustedRepositories, machine, usage, readLoad, readUsage };
}

export type Trierarch = ReturnType<typeof aTrierarch>;


/** The machine as the container runtime's checks read it: a rootless Podman, the user in no docker group, the model token written. */
export class InMemoryContainerHost implements ContainerHostPort {
  mode: RuntimeMode = 'rootless';
  groups: readonly string[] = ['thomas', 'sudo'];
  hasModelToken = true;
  readonly asked: string[] = [];

  runtimeMode(binary: string): Promise<RuntimeMode> {
    this.asked.push(binary);
    return Promise.resolve(this.mode);
  }

  userGroups(): Promise<readonly string[]> {
    return Promise.resolve(this.groups);
  }

  isModelTokenWritten(): Promise<boolean> {
    return Promise.resolve(this.hasModelToken);
  }
}
