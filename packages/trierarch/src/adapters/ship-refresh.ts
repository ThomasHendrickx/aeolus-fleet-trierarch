import type { ShipId } from '@aeolus-fleet/common';

import type { RefreshedCheckout, StatePort } from '../core/ports.js';

/**
 * What a ship's session refreshes through its socket (`aeolus-checkouts.sh
 * refresh`; #1182, aeolus-fleet#1449): its read-only workspace first, when
 * its workspace is one, then each of its read-only checkouts, each answering
 * its revision or why it could not.
 */
export function createShipRefresh(at: {
  state: Pick<StatePort, 'load'>;
  workspace: { refresh(at: { repository: string; folder: string }): Promise<RefreshedCheckout | undefined> };
  checkouts: { refresh(shipId: ShipId): Promise<readonly RefreshedCheckout[]> };
}): (shipId: ShipId) => Promise<readonly RefreshedCheckout[]> {
  return async (shipId) => {
    const entry = (await at.state.load()).entries[shipId];
    const workspace = entry?.workspace.kind === 'worktree' && entry.folder !== undefined ? await at.workspace.refresh({ repository: entry.workspace.repository, folder: entry.folder }) : undefined;
    return [...(workspace === undefined ? [] : [workspace]), ...(await at.checkouts.refresh(shipId))];
  };
}
