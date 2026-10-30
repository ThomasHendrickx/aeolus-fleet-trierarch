import { stat } from 'node:fs/promises';

import type { ShipId } from '@aeolus-fleet/common';

import type { SessionLogins } from '../core/login.js';
import type { ModelTokens, SubscriptionWindow, UsagePort } from '../core/ports.js';

/** What one harness says of its usage (#353): a ship's tokens from its transcripts, and its subscription's windows. */
export interface HarnessUsageReader {
  tokensOf(ship: { shipId: ShipId; folder: string; logins?: SessionLogins }): Promise<readonly ModelTokens[]>;
  subscription(): Promise<readonly SubscriptionWindow[] | undefined>;
}

/** The harnesses' usage (#353), each from the reader of its harness; a harness with none says nothing. */
export function createUsage(readers: Readonly<Record<string, HarnessUsageReader>>): UsagePort {
  return {
    tokensOf: ({ harness, ...ship }) => readers[harness]?.tokensOf(ship) ?? Promise.resolve([]),
    subscriptionOf: (harness) => readers[harness]?.subscription() ?? Promise.resolve(undefined),
  };
}

/** When the folder was made, so what a session of another crew in a folder of the same name used counts not; when it changed last where the filesystem keeps no birth time. */
export async function folderMadeAt(folder: string): Promise<Date> {
  const stats = await stat(folder);
  return stats.birthtimeMs > 0 ? stats.birthtime : stats.ctime;
}
