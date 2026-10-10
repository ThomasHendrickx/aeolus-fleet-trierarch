import type { RunningFile } from '../adapters/files.js';
import type { Service, ServiceStatus } from '../adapters/service.js';

/**
 * Starts a new trierarch process (restart, install) and waits until it has
 * said its version in running.json, so the status that follows shows the
 * version it runs (#402, the race #376 fixed for upgrade). running.json is the
 * new process's once its pid is the one the service runs: the old process's
 * file may name the same version. It waits at most 30 seconds.
 */

export const NOT_SAID_YET = 'The new process has not said its version after 30 seconds: aeolus-trierarch status shows the version it runs once it does.';

const CHECK_MS = 1000;
const TIMEOUT_MS = 30_000;

export interface NewProcess {
  /** The service as it stands after the wait. */
  readonly status: ServiceStatus;
  readonly hasSaidVersion: boolean;
}

export async function startNewProcess(at: {
  start: () => Promise<void>;
  service: Pick<Service, 'status'>;
  /** What running.json says now: the new process writes it as it starts. */
  running: () => Promise<RunningFile | undefined>;
  /** Waits between reads of running.json; a test passes one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
}): Promise<NewProcess> {
  const sleep = at.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  await at.start();
  for (let waited = 0; ; waited += CHECK_MS) {
    const [status, running] = await Promise.all([at.service.status(), at.running()]);
    if (status.isRunning && running !== undefined && running.pid === status.pid) {
      return { status, hasSaidVersion: true };
    }
    if (waited >= TIMEOUT_MS) {
      return { status, hasSaidVersion: false };
    }
    await sleep(CHECK_MS);
  }
}
