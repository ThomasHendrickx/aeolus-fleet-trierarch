import type { TrierarchConfiguration, TrierarchEntryState } from '@aeolus-fleet/common';

import type { CrewFile } from '../adapters/files.js';
import { FleetRefusal } from '../adapters/rest-fleet.js';
import type { Service, ServiceStatus } from '../adapters/service.js';
import type { KeptWorktree } from '../core/entry.js';
import type { ProcessPort, StatePort } from '../core/ports.js';

/**
 * `aeolus-trierarch status`: how the trierarch stands on this machine, from
 * what is on it. The service and its process, the fleet and the trierarch's
 * own lease (one whoami, no message), the caps in use, the entries by state,
 * and the worktrees kept or orphaned.
 */

/** The trierarch's own lease: whoami answers while it holds, the fleet refuses the crew token once it ended. */
export type Lease = 'valid' | 'ended' | 'unreachable';

export interface StatusReport {
  readonly service: ServiceStatus;
  readonly fleet: { readonly url: string; readonly shipId?: string; readonly lease: Lease };
  readonly caps: { readonly ships: { readonly used: number; readonly cap: number }; readonly running: { readonly used: number; readonly cap: number } };
  readonly entries: Readonly<Record<TrierarchEntryState, number>>;
  readonly kept: readonly KeptWorktree[];
  readonly orphans: readonly string[];
}

export function leaseFrom(whoami: () => Promise<unknown>): () => Promise<Lease> {
  return async () => {
    try {
      await whoami();
      return 'valid';
    } catch (error) {
      if (error instanceof FleetRefusal && (error.code === 'LEASE_ENDED' || error.code === 'UNAUTHORIZED')) {
        return 'ended';
      }
      return 'unreachable';
    }
  };
}

export async function inspectStatus(at: {
  configuration: TrierarchConfiguration;
  crew: CrewFile;
  service: Pick<Service, 'status'>;
  lease: () => Promise<Lease>;
  processes: ProcessPort;
  state: StatePort;
}): Promise<StatusReport> {
  const [service, lease, sessions, state] = await Promise.all([at.service.status(), at.lease(), at.processes.list(), at.state.load()]);
  const entries: Record<TrierarchEntryState, number> = { wanted: 0, crewing: 0, running: 0, restarting: 0, crashed: 0, releasing: 0 };
  for (const entry of Object.values(state.entries)) {
    entries[entry.state] += 1;
  }
  return {
    service,
    fleet: { url: at.crew.fleetUrl, ...(at.crew.shipId !== undefined && { shipId: at.crew.shipId }), lease },
    caps: {
      ships: { used: Object.keys(state.entries).length, cap: at.configuration.caps.ships },
      running: { used: sessions.filter((session) => session.status === 'running').length, cap: at.configuration.caps.running },
    },
    entries,
    kept: state.kept,
    orphans: state.orphans,
  };
}

function describeService(service: ServiceStatus): string {
  if (!service.isInstalled) {
    return 'not installed (aeolus-trierarch install)';
  }
  if (!service.isRunning) {
    return 'installed, not running (aeolus-trierarch start)';
  }
  return ['running', ...(service.pid === undefined ? [] : [`pid ${String(service.pid)}`]), ...(service.since === undefined ? [] : [`since ${service.since}`])].join(', ');
}

function describeFleet(fleet: StatusReport['fleet']): string {
  const ship = fleet.shipId ?? 'its ship';
  switch (fleet.lease) {
    case 'valid':
      return `${fleet.url}, the lease of ${ship} is valid`;
    case 'ended':
      return `${fleet.url}, the lease of ${ship} ended: its ship was released or retired, so it crews nothing`;
    case 'unreachable':
      return `${fleet.url} cannot be reached`;
  }
}

export function describeStatus(report: StatusReport): string {
  const counted = Object.entries(report.entries).filter(([, count]) => count > 0);
  return [
    `Service: ${describeService(report.service)}`,
    `Fleet: ${describeFleet(report.fleet)}`,
    `Caps: ${String(report.caps.ships.used)} of ${String(report.caps.ships.cap)} ships on the list, ${String(report.caps.running.used)} of ${String(report.caps.running.cap)} sessions running`,
    `Entries: ${counted.length === 0 ? 'none' : counted.map(([state, count]) => `${state} ${String(count)}`).join(', ')}`,
    `Kept worktrees: ${report.kept.length === 0 ? 'none' : report.kept.map((kept) => `${kept.path} (${kept.shipId})`).join(', ')}`,
    `Orphans: ${report.orphans.length === 0 ? 'none' : report.orphans.join(', ')}`,
  ].join('\n');
}
