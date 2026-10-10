import type { RunningFile } from '../adapters/files.js';
import type { Service, ServiceStatus } from '../adapters/service.js';
import { NOT_SAID_YET, startNewProcess } from './new-process.js';

/**
 * `aeolus-trierarch start`, `restart` and `install`: each starts a new
 * trierarch process and answers once it has said its version, through the one
 * wait every start shares (#466), so the status it answers is the new
 * process's.
 */

export type ServiceCommand = 'start' | 'restart' | 'install';

export interface ServiceAnswer {
  readonly status: ServiceStatus;
  readonly text: string;
}

/** How the service stands after a command, in the operator's words. */
export function describeService(verb: string, status: ServiceStatus): string {
  return status.isRunning ? `The trierarch ${verb}: it runs${status.pid === undefined ? '' : ` as pid ${String(status.pid)}`}.` : `The trierarch ${verb}: it does not run.`;
}

export async function runServiceCommand(at: {
  command: ServiceCommand;
  service: Pick<Service, ServiceCommand | 'status'>;
  /** The folder of the logs, named after an install. */
  logs: string;
  /** What running.json says now: the new process writes it as it starts. */
  running: () => Promise<RunningFile | undefined>;
  /** Waits between reads of running.json; a test passes one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
}): Promise<ServiceAnswer> {
  const { command, service } = at;
  const { status, hasSaidVersion } = await startNewProcess({ start: () => service[command](), service, running: at.running, ...(at.sleep !== undefined && { sleep: at.sleep }) });
  const done = {
    start: () => describeService('started', status),
    restart: () => describeService('restarted', status),
    install: () => `Installed ${status.file}. Logs: ${at.logs}`,
  }[command]();
  return { status, text: [done, ...(hasSaidVersion ? [] : [NOT_SAID_YET])].join(' ') };
}
