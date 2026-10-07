import type { CrewStatus, ShipId, TrierarchConfiguration, TrierarchReportDetails, TrierarchWorkspace } from '@aeolus-fleet/common';

import type { TrierarchState } from './entry.js';
import type { Action } from './reconciler.js';

/**
 * The trierarch's ports (docs/architecture.md, "The trierarch"). Adapters
 * implement them in D2b: REST for the fleet, tmux for processes, git worktree
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

/** What a session's inbox says: deliveries waiting, or the lease ended (released or retired elsewhere). */
export type InboxAnswer = { readonly kind: 'waiting'; readonly count: number } | { readonly kind: 'leaseEnded' };

/** A crew request assigned to the trierarch's ship, as `fleet.assignedCrewRequests` answers: its settings unread. */
export interface AssignedRequest {
  readonly shipId: ShipId;
  readonly settings: unknown;
  readonly settingsVersion: number;
  /** How the trierarch last said the crew stands; releasing once the requester removed it; null until any. */
  readonly status: CrewStatus | null;
}

/** A plain-text report to argo, the operator, stored once under its idempotency key. */
export interface ArgoReport {
  readonly text: string;
  readonly idempotencyKey: string;
}

/**
 * The fleet as the trierarch's own ship calls it, with `crew:run`: it reaches
 * only the ships whose crew requests are assigned to it (decision 0029).
 */
export interface FleetPort {
  /** The fleet's URL, written into each session's identity. */
  readonly url: string;
  /** The crew requests assigned to the trierarch's ship, oldest ship first. */
  assignedRequests(): Promise<readonly AssignedRequest[]>;
  /** Says how its crew of an assigned ship stands. */
  writeStatus(shipId: ShipId, status: CrewStatus): Promise<void>;
  /** Confirms it released the ship of a releasing request, which then goes. */
  confirmRelease(shipId: ShipId): Promise<void>;
  ship(shipId: ShipId): Promise<FleetShipStatus>;
  /** A new starting prompt's secret; the trierarch keeps it only until it registers. */
  getStartingPrompt(shipId: ShipId): Promise<{ secret: string }>;
  /** Registers the ship with its secret, as the session's crew: its crew token. */
  register(crew: { shipId: ShipId; secret: string }): Promise<{ crewToken: string }>;
  release(shipId: ShipId): Promise<void>;
  /** Acknowledges a delivery to the trierarch's own ship. */
  ack(deliveryId: string): Promise<void>;
  /** Answers a ping to the trierarch's own ship. */
  pong(deliveryId: string): Promise<void>;
  /** Sends argo a report, as the trierarch's own ship. */
  reportToArgo(report: ArgoReport): Promise<void>;
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

/** What a session's folder identity holds for the trierarch: written through the aeolus plugin, never a copy of it. */
export interface Identity {
  readonly fleetUrl: string;
  readonly shipId: ShipId;
  readonly shipName: string;
  readonly crewToken: string;
  readonly squadron?: string;
}

/** The turn a session is in, from the plugin's turn marker. */
export type Turn = 'busy' | 'idle' | 'unknown';

export interface HarnessPort {
  /** Writes the folder's identity with wakeBy=trierarch, as the aeolus plugin does. */
  prepareIdentity(at: { folder: string; identity: Identity }): Promise<void>;
  /** The crew token of the folder's identity, when there is one. */
  crewTokenOf(folder: string): Promise<string | undefined>;
  removeIdentity(folder: string): Promise<void>;
  /** Starts the harness in the folder: the first start with the settings' first prompt, later ones continuing. */
  launch(session: {
    shipId: ShipId;
    /** With the workspace, what the session is named after where the harness names one. */
    shipName: string;
    folder: string;
    workspace: TrierarchWorkspace;
    harness: string;
    options: Readonly<Record<string, string>>;
    isFirstStart: boolean;
    firstPrompt?: string;
  }): Promise<void>;
  turnOf(folder: string): Promise<Turn>;
  wake(session: { shipId: ShipId; folder: string }): Promise<void>;
}

/** A session the process supervisor runs, by ship id: running, or exited and kept so the exit is seen. */
export interface ObservedSession {
  readonly shipId: ShipId;
  readonly status: 'running' | 'exited';
}

export interface ProcessPort {
  list(): Promise<readonly ObservedSession[]>;
  stop(shipId: ShipId): Promise<void>;
}

/** A worktree under the trierarch's root, with the ship it is named after when it is one. */
export interface ObservedWorktree {
  readonly path: string;
  readonly shipId?: ShipId;
}

export interface WorkspacePort {
  /** Makes the workspace, or finds the one a stop mid-crew left half made: its folder. */
  prepare(workspace: { shipId: ShipId; shipName: string; workspace: TrierarchWorkspace }): Promise<{ folder: string }>;
  isClean(folder: string): Promise<boolean>;
  /** Removes a worktree the trierarch made; never a configured folder. */
  remove(folder: string): Promise<void>;
  worktrees(): Promise<readonly ObservedWorktree[]>;
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
  readonly action: Exclude<Action['kind'], 'argo' | 'status' | 'refuse'> | 'leave';
  readonly outcome: string;
  /** For a failure: what happens next, and where to look. */
  readonly next?: string;
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

/** The trierarch's configuration, its version, and the flags each harness's adapter adds itself. */
export interface TrierarchSetup {
  readonly configuration: TrierarchConfiguration;
  readonly version: string;
  readonly adapterFlags: Readonly<Record<string, readonly AdapterFlag[]>>;
}
