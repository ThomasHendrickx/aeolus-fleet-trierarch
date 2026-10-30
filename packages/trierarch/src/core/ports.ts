import type { ClearOutcome, CrewStatus, ShipId, TrierarchConfiguration, TrierarchReportDetails, TrierarchWorkspace } from '@aeolus-fleet/common';

import type { TrierarchState } from './entry.js';
import type { KeyStateAt, Login, SessionLogins } from './login.js';
import type { Machine } from './machine.js';
import type { MachineLoad } from './machine-load.js';
import type { TokenCounts } from './token-cost.js';
import type { Action } from './reconciler.js';
import type { TrustedRepository } from './trusted-repositories.js';

/**
 * The trierarch's ports (docs/architecture.md, "The trierarch"). Adapters
 * implement them in D2b: REST for the fleet, holds for the sessions, git worktree
 * and folders for workspaces, Claude Code for the harness, a JSON file for
 * state. Each throws only for a system failure.
 */

/** Where a ship stands in the fleet, as `fleet.ship` answers the trierarch (crew:run, for a ship assigned to it). */
export type FleetShipStatus = { readonly kind: 'awaitingCrew'; readonly name: string } | { readonly kind: 'crewed'; readonly name: string } | { readonly kind: 'retired' } | { readonly kind: 'notFound' };

/** A delivery to the trierarch's own ship. */
export interface Delivery {
  readonly deliveryId: string;
  readonly messageId: string;
  readonly senderShipId: ShipId;
  readonly contentType: string;
  readonly payload: string;
}

/** What a session's inbox says: deliveries waiting, of them those forced and not handed over yet (decision 0040), or the lease ended (released or retired elsewhere). */
export type InboxAnswer = { readonly kind: 'waiting'; readonly count: number; readonly forced: number } | { readonly kind: 'leaseEnded' };

/** A clear request to the trierarch's ship: the kept worktree, by the ship it belonged to and its repository. */
export interface ClearRequestToMe {
  readonly shipId: ShipId;
  readonly repository: string;
}

/** A crew request assigned to the trierarch's ship, as `fleet.assignedCrewRequests` answers: its settings unread. */
export interface AssignedRequest {
  readonly shipId: ShipId;
  readonly settings: unknown;
  readonly settingsVersion: number;
  /** How the trierarch last said the crew stands; releasing once the requester removed it; null until any. */
  readonly status: CrewStatus | null;
  /** Whether its crew is final as the fleet holds it (decision 0029): read, never derived from the status (#477). */
  readonly isFinal: boolean;
  /** Its ship's owner as the fleet holds it now, where its trouble goes (decision 0045); null for a ship with none. */
  readonly owner: ShipOwner | null;
}

/** A ship's owner: a person's ship, or argo (decision 0045). */
export interface ShipOwner {
  readonly shipId: ShipId;
  readonly name: string;
}

/** A plain-text report to argo, the operator, stored once under its idempotency key. */
export interface ArgoReport {
  readonly text: string;
  readonly idempotencyKey: string;
}

/** A report to a ship's owner by its ship's id, stored once under its idempotency key (decision 0045). */
export interface OwnerReport extends ArgoReport {
  readonly ownerShipId: ShipId;
}

/** How the fleet answered a report to an owner: sent, or refused with its code and message, as when no rule lets the trierarch reach it. */
export type OwnerReportAnswer = { readonly kind: 'sent' } | { readonly kind: 'refused'; readonly code: string; readonly message: string };

/**
 * The fleet as the trierarch's own ship calls it, with `crew:run`: it reaches
 * only the ships whose crew requests are assigned to it (decision 0029).
 */
/** A crew status as the trierarch writes it: the status, how many times it restarted the session within its window (0 on its first start), and when the session it runs now started, or null while none runs. */
export interface WrittenStatus {
  readonly status: CrewStatus;
  readonly attempt: number;
  readonly startedAt: Date | null;
}

/** How the fleet answered a give-back (#382): it took the request back, or refused with its code and message. */
export type GiveBackAnswer = { readonly kind: 'givenBack' } | { readonly kind: 'refused'; readonly code: string; readonly message: string };

export interface FleetPort {
  /** The fleet's URL, written into each session's identity. */
  readonly url: string;
  /** The crew requests assigned to the trierarch's ship, oldest ship first. */
  assignedRequests(): Promise<readonly AssignedRequest[]>;
  /** Says how its crew of an assigned ship stands, with the restart attempt and when the session started (#332). */
  writeStatus(shipId: ShipId, written: WrittenStatus): Promise<void>;
  /**
   * Gives back a request it cannot crew, for the settings version it tried,
   * while its crew is not final (#382): the fleet unassigns it and ends the
   * ship's lease. A refusal is answered, not thrown.
   */
  giveBack(shipId: ShipId, given: { settingsVersion: number; reason: string }): Promise<GiveBackAnswer>;
  /** The trierarch's own ship, as its crew token says: its name names the machine. It answers while the lease holds. */
  whoami(): Promise<{ shipId: ShipId; name: string }>;
  /** Confirms it released the ship of a releasing request, which then goes. */
  confirmRelease(shipId: ShipId): Promise<void>;
  ship(shipId: ShipId): Promise<FleetShipStatus>;
  /** A new starting prompt's secret; the trierarch keeps it only until it registers. */
  getStartingPrompt(shipId: ShipId): Promise<{ secret: string }>;
  /** Registers the ship with its secret, as the session's crew in its harness: its crew token. */
  register(crew: { shipId: ShipId; secret: string; harness: string }): Promise<{ crewToken: string }>;
  release(shipId: ShipId): Promise<void>;
  /** Acknowledges a delivery to the trierarch's own ship. */
  ack(deliveryId: string): Promise<void>;
  /** Answers a ping to the trierarch's own ship. */
  pong(deliveryId: string): Promise<void>;
  /** The pending clear requests to the trierarch's own ship, oldest first (decision 0032). */
  pendingClears(): Promise<readonly ClearRequestToMe[]>;
  /** Confirms a clear request: it removed the kept worktree, or keeps none; the request then goes. */
  confirmCleared(cleared: ClearRequestToMe & { outcome: ClearOutcome }): Promise<void>;
  /** Asks the trierarch plugin's ship for the trusted repositories again, as the trierarch's own ship (aeolus-fleet#384). */
  askForTrustedRepositories(pluginShipId: ShipId): Promise<void>;
  /** Sends argo a report, as the trierarch's own ship. */
  reportToArgo(report: ArgoReport): Promise<void>;
  /** Sends a ship's owner a report, as the trierarch's own ship. A refusal is answered, not thrown. */
  reportToOwner(report: OwnerReport): Promise<OwnerReportAnswer>;
  /** A session's inbox, asked with its crew token. */
  inbox(crewToken: string): Promise<InboxAnswer>;
  /** Reports on a ship's behalf, with its session's crew token. */
  report(crew: { crewToken: string; state: 'blocked' | 'working'; note: string }): Promise<void>;
  /** Reports as the trierarch's own ship: what it does, and its details. */
  reportSelf(report: SelfReport): Promise<void>;
}

/** The trierarch's own report: idle or working, how many sessions run, and its details (docs/trierarch.md). */
export interface SelfReport {
  readonly state: 'idle' | 'working';
  readonly note: string;
  readonly details: TrierarchReportDetails;
}

/** What a session's folder identity holds for the trierarch: written through the aeolus-fleet plugin, never a copy of it. No crew token: the session calls over its ship's socket (decision 0026). */
export interface Identity {
  readonly fleetUrl: string;
  readonly shipId: ShipId;
  readonly shipName: string;
  readonly socket: string;
  readonly squadron?: string;
  /** The session's read-only checkouts (#1182), which its start context names; none when it has none. */
  readonly checkouts?: readonly Checkout[];
}

/**
 * The socket of each ship the trierarch crews (decision 0026): its session's
 * fleet calls come over it, and the trierarch adds the crew token from its
 * state.
 */
export interface ShipSocketsPort {
  /** Opens the ship's socket, or keeps the one open; answers its path. */
  open(shipId: ShipId): Promise<string>;
  close(shipId: ShipId): Promise<void>;
}

/** The turn a session is in, from the plugin's turn marker. */
export type Turn = 'busy' | 'idle' | 'unknown';

/** What a hand-over came to (#756): a message handed over, its line typed into the session, or nothing to hand. */
export type HandOver = 'handed' | 'nothing';

export interface HarnessPort {
  /**
   * Writes the folder's identity with wakeBy=trierarch, as the aeolus-fleet plugin does. The
   * crew token goes to the plugin only for the lease it stands for, never into the folder.
   */
  prepareIdentity(at: { folder: string; identity: Identity; crewToken: string }): Promise<void>;
  /** Whether the session's folder still holds its identity (#659). */
  hasIdentity(session: { shipId: ShipId; folder: string }): Promise<boolean>;
  removeIdentity(session: { shipId: ShipId; folder: string }): Promise<void>;
  /** Starts the harness in the folder: the first start with the settings' first prompt, later ones continuing. */
  launch(session: {
    shipId: ShipId;
    /** With the workspace, what the session is named after where the harness names one. */
    shipName: string;
    folder: string;
    workspace: TrierarchWorkspace;
    /** The session's read-only checkouts (#1182), which it may read beside its folder. */
    checkouts: readonly Checkout[];
    harness: string;
    options: Readonly<Record<string, string>>;
    isFirstStart: boolean;
    /** Fresh for each start (#490): the session's hooks mark this launch, and nothing of another counts. */
    launchId: string;
    /** The one login the session runs on (api keys K6): the model proxy with a token of its own, or the subscription alone. */
    login: Login;
    firstPrompt?: string;
  }): Promise<void>;
  turnOf(session: { shipId: ShipId; folder: string }): Promise<Turn>;
  /** Hands one message over through the aeolus-fleet plugin, which keeps the store, and types the line it gives into the session (#756, 2a). */
  handOver(session: { shipId: ShipId; folder: string }): Promise<HandOver>;
  /**
   * Hands a forced message over first through the aeolus-fleet plugin (decision
   * 0040), and types the line it gives into the session as a new prompt. A
   * busy turn is stopped for it first: force means act now.
   */
  forceOver(session: { shipId: ShipId; folder: string; isTurnBusy: boolean }): Promise<HandOver>;
  /** Whether the session's store holds a message to hand: received, handed and not confirmed, or to hand once more (#756). */
  isHolding(session: { shipId: ShipId; folder: string }): Promise<boolean>;
  /** Tells the session's store that its session died, before it starts again (#756, 3.5 to 3.7, 3.10). */
  sessionDied(session: { shipId: ShipId; folder: string }): Promise<void>;
  /** What the session did in its launch window (#382), as its hooks marked the launch it was started for (#490), for the model it launched with; any model refused when it launched with none. */
  launchSeen(session: { shipId: ShipId; folder: string; launchId: string; model?: string }): Promise<LaunchSeen>;
  /** Whether the harness's aeolus-fleet plugin marks launches (#490); one older than the launch marker does not, and its sessions are not crewed. */
  marksLaunches(): Promise<boolean>;
  /** Why the machine does not offer the harness now, as for a build its plugin's hooks are not proven on or a runtime it is not proven in (CC3, CC10); none while it offers it. */
  notOfferedReason(): Promise<string | undefined>;
  /** Why no session of the harness can start now, as when its aeolus-fleet plugin's scripts are gone (#827); none when one can. */
  startProblem(): Promise<string | undefined>;
}

/**
 * What a session did in its launch window (#382): activity once its first
 * prompt made a tool call, the model refused (by its id when that is known),
 * or neither yet, with the harness's own screen it stopped at when it knows
 * that screen (#403), such as `bypass permissions warning`, or the cause its
 * harness's last error event gave (headless H13), such as a refused login.
 */
export type LaunchSeen = { readonly kind: 'active' } | { readonly kind: 'refused'; readonly model?: string } | { readonly kind: 'none'; readonly screen?: string; readonly cause?: string };

/** A session the session runtime runs, by ship id: running, or exited and kept so the exit is seen; and whether another version of the trierarch started it, which this one does not speak to (headless H19). */
export interface ObservedSession {
  readonly shipId: ShipId;
  readonly status: 'running' | 'exited';
  readonly isOtherVersion?: boolean;
}

/**
 * Where the sessions run (decision 0039): one session per ship, by ship id,
 * kept on exit so an exit is seen. The reconciler lists and stops them; the
 * harness adapters start them, send them lines, stop their turns and read
 * what their harness wrote (headless H9).
 */
export interface SessionRuntime {
  list(): Promise<readonly ObservedSession[]>;
  stop(shipId: ShipId): Promise<void>;
  /**
   * Starts the command in the folder, with the environment given, in a new session for the ship; an exited one is replaced. `harness` names the harness the command runs, for how its turn is stopped;
   * `readOnly` names its read-only checkouts (#1182), which a container mounts read-only and the host leaves as they are.
   */
  start(session: { shipId: ShipId; folder: string; command: readonly string[]; harness: string; env?: Readonly<Record<string, string>>; readOnly?: readonly string[]; proxyToken?: ProxyToken }): Promise<void>;
  /** Sends one line to the session's harness as its next input. */
  send(at: { shipId: ShipId; line: string }): Promise<void>;
  /** Stops the session's running turn and waits for its end, within a bound; the session goes on (decision 0040, headless H12). */
  interrupt(shipId: ShipId): Promise<void>;
  /** What the session's harness wrote last, one line each, oldest first: its events, or its screen in a terminal; none with no session. */
  events(shipId: ShipId): Promise<readonly string[]>;
}

/**
 * Whether a session of a harness can start on a login now (api keys K9): an
 * API key that is not ready holds back every session on it, and it never
 * starts on the subscription instead (K2).
 */
export interface ModelLoginsPort {
  /** Why no session of the harness can start on the login now, with the options picked and in the folder when it has one, such as a key not ready or, on the subscription, a key in reach (K6); none when one can. */
  startProblem(at: { harness: string; login: Login; options: Readonly<Record<string, string>>; folder?: string }): Promise<string | undefined>;
  /** Where the harness's API key stands (K8): a running session on a key that is not ready is handed nothing (K9). */
  keyState(harness: string): Promise<KeyStateAt>;
}

/**
 * A session's own token for the model proxy (headless H16, api keys K7): kept
 * in a file of the session's own and handed to its harness in the variable
 * named, never on a command line or in the environment it is started with.
 */
export interface ProxyToken {
  readonly harness: string;
  readonly variable: string;
  readonly token: string;
}

/** The processes running in a folder, whatever started them: a dev server a session left behind. */
export interface FolderProcessesPort {
  /** Stops every process whose working folder is the folder or inside it, and answers how many it stopped. */
  stopIn(folder: string): Promise<number>;
}

/** A worktree under the trierarch's root (`<root>/<repository>/<name>`), with the ship it is named after when it is one. */
export interface ObservedWorktree {
  readonly path: string;
  readonly repository: string;
  readonly name: string;
  readonly shipId?: ShipId;
}

/**
 * The configured repositories and folders each configured harness trusts, by
 * name (#381), and its flags whose one-time question is not accepted yet: a
 * session launched with one waits on that question (#403).
 */
export type TrustedPlaces = Readonly<Record<string, { readonly repositories: readonly string[]; readonly folders: readonly string[]; readonly unacceptedFlags: readonly string[] }>>;

/**
 * What each harness trusts now, as its own files say (#381). Init trusts a
 * place as it adds it; the trierarch only reads: a place a harness does not
 * trust is never offered and never crewed.
 */
export interface TrustPort {
  trusted(): Promise<TrustedPlaces>;
}

/** How a container runtime runs: as the user (rootless), as root, or not at all. */
export type RuntimeMode = 'rootless' | 'rootful' | 'missing';

/** What the container runtime's checks read of the machine (decision 0039). */
export interface ContainerHostPort {
  runtimeMode(binary: string): Promise<RuntimeMode>;
  /** The groups of the user that runs the trierarch, by name. */
  userGroups(): Promise<readonly string[]>;
  /** Whether the machine's model token file holds a token. */
  isModelTokenWritten(): Promise<boolean>;
}

export interface WorkspacePort {
  /** Makes the workspace, or finds the one a stop mid-crew left half made: its folder. */
  prepare(workspace: { shipId: ShipId; shipName: string; workspace: TrierarchWorkspace }): Promise<{ folder: string }>;
  isClean(folder: string): Promise<boolean>;
  /**
   * What removing the worktree would discard, one line each (#450): each change
   * not committed, as git status shows it, then each commit no branch, tag or
   * remote branch keeps. None when everything in it is kept elsewhere.
   */
  unsaved(folder: string): Promise<readonly string[]>;
  /** Whether the folder is a worktree the trierarch made: one `<root>/<repository>/<ship>` of a repository it has, which git knows. Anything else under its root is not its to clear. */
  isMade(folder: string): Promise<boolean>;
  /** Removes a worktree the trierarch made; never a configured folder. */
  remove(folder: string): Promise<void>;
  worktrees(): Promise<readonly ObservedWorktree[]>;
}

/** A read-only checkout a session gets beside its working folder (#1182): the configured repository it is of, and where it is. */
export interface Checkout {
  readonly repository: string;
  readonly path: string;
}

/** What refreshing a checkout came to: the revision it now holds, or why it could not, as one line. */
export type RefreshedCheckout = { readonly repository: string; readonly revision: string } | { readonly repository: string; readonly problem: string };

/**
 * The read-only checkouts of each ship (#1182): the repositories the
 * configuration names for its working repository, at the latest main, one
 * folder per ship. The session can change, commit and push nothing in them.
 */
export interface CheckoutsPort {
  /** Makes the ship's checkouts its working repository names, keeping those it has; answers each, none for a repository that names none. */
  prepare(at: { shipId: ShipId; repository: string }): Promise<readonly Checkout[]>;
  /** Brings each of the ship's checkouts to the latest main of its repository; one that cannot be refreshed says why and holds what it held. */
  refresh(shipId: ShipId): Promise<readonly RefreshedCheckout[]>;
  /** Removes every checkout of the ship. */
  remove(shipId: ShipId): Promise<void>;
}

export interface StatePort {
  load(): Promise<TrierarchState>;
  save(state: TrierarchState): Promise<void>;
}

/** What the loop did for a ship, and how it came out: one line of the trierarch's log (aeolus-trierarch logs). */
export interface LoggedAction {
  readonly time: Date;
  readonly shipId: ShipId;
  /** Known once the ship was first crewed. */
  readonly shipName?: string;
  /** What the loop did for the ship: an action it carried out, or leave when another session crews the ship. */
  readonly action: Exclude<Action['kind'], 'status' | 'refuse'> | 'leave';
  readonly outcome: string;
  /** For a failure: what happens next, and where to look. */
  readonly next?: string;
}

/** An option as the configuration gives it: its values by name, each with its flags, and its default. */
export type ConfiguredOption = TrierarchConfiguration['harnesses'][string]['options'][string];

/** What detection found for one harness on this machine (#365). */
export interface DetectedHarness {
  /** Its version, as its CLI says it. */
  readonly version: string;
  readonly detectedAt: Date;
  /** When its models were last confirmed; null while none is. */
  readonly confirmedAt: Date | null;
  /** Its options as detected: its models, and its effort levels where its CLI has a flag for them. */
  readonly options: Readonly<Record<string, ConfiguredOption>>;
  /** The permission modes its CLI lists for its permission mode flag (#517), so a launch names a mode the installed version documents; none when it lists none. */
  readonly permissionModes?: readonly string[];
  /** Why detection could not find what it should, for argo, once per version; none when it found it. */
  readonly problem?: string;
  /** The model ids a session on this machine refused at this version (#382), never offered again until the version changes or a hand detect; none when none was. */
  readonly refused?: readonly RefusedModel[];
}

/** A model id a session refused, and when it was seen on its screen. */
export interface RefusedModel {
  readonly id: string;
  readonly at: Date;
}

/** What detection found, per harness. */
export type Detected = Readonly<Record<string, DetectedHarness | undefined>>;

/** A harness's CLI as detection asks it (#365). */
export interface HarnessDetector {
  /** Its version; undefined when it does not say one, such as when it is not installed. */
  version(): Promise<string | undefined>;
  /** Its options at that version, given what was detected before; undefined when it gives nothing to detect. */
  detect(at: { version: string; previous: DetectedHarness | undefined; now: Date }): Promise<DetectedHarness | undefined>;
}

/** Where the trierarch keeps what it detected, apart from the operator's configuration. */
export interface DetectedStore {
  load(): Promise<Detected>;
  save(detected: Detected): Promise<void>;
}

export interface Logger {
  warn(message: string): void;
  action(logged: LoggedAction): void;
}

/** A flag a harness adapter adds itself, as mechanism, never the operator's: on every launch or on a restart only. */
export interface AdapterFlag {
  readonly flag: string;
  readonly when: 'always' | 'restart';
}

/** The trierarch's configuration, its version, the flags each harness's adapter adds itself, and those its adapter calls risky. */
export interface TrierarchSetup {
  /** What the machine offers: its configuration with what detection found and the trusted repositories. */
  readonly configuration: TrierarchConfiguration;
  /** The configuration as its file gives it: the trierarch started with another one offers its machine again after failed starts (#853). */
  readonly configured: TrierarchConfiguration;
  readonly version: string;
  readonly adapterFlags: Readonly<Record<string, readonly AdapterFlag[]>>;
  readonly riskyFlags: Readonly<Record<string, readonly string[]>>;
  /** The machine it runs on, by os and arch, for the trierarch plugin's labels (#102); none reports none. */
  readonly machine?: Machine;
  /** What detection found per harness (#365), for the version and confirmed time the report gives. */
  readonly detected?: Detected;
}

/**
 * The trusted repositories the trierarch received last from the trierarch
 * plugin (aeolus-fleet#384), kept across restarts: each one it offers and
 * clones on its first workspace.
 */
export interface TrustedRepositoriesPort {
  /** The list as last accepted; none before the first. */
  current(): readonly TrustedRepository[];
  /** Keeps the list, and trusts each one's clone for every configured harness, so a session may start in it (#381). */
  accept(list: readonly TrustedRepository[]): Promise<void>;
}

/** The machine the trierarch runs on, as it reads its load (#400): memory, swap, CPU, and the disk its worktree root is on. */
export interface MachinePort {
  load(): Promise<MachineLoad>;
}

/** The tokens of one model a ship's sessions used (#353), on one login when the ship's logins were given (api keys K8). */
export interface ModelTokens {
  readonly model: string;
  readonly login?: Login;
  readonly tokens: TokenCounts;
}

/** One window of a harness's subscription (#353): how long it is, how much of it is used, and when it starts again. */
export interface SubscriptionWindow {
  readonly windowMinutes: number;
  readonly usedPercent: number;
  readonly resetsAt: Date;
}

/** What the harnesses say of their usage (#353), from their own files and CLIs. */
export interface UsagePort {
  /** The tokens the ship's sessions used since its folder was made, per model, from its harness's transcripts; given its logins, per model and login, each counted to the login of the session that wrote it (api keys K8). */
  tokensOf(ship: { shipId: ShipId; harness: string; folder: string; logins?: SessionLogins }): Promise<readonly ModelTokens[]>;
  /** How much of the harness's subscription is used now, per window; none when the harness cannot say. */
  subscriptionOf(harness: string): Promise<readonly SubscriptionWindow[] | undefined>;
}
