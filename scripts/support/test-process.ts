import { appendFileSync, readFileSync } from 'node:fs';

/** Stops only the process and descendants started by this test, by their individual PIDs. */
export function stopProcess(pid: number, parent: number): void {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(fields[1]) !== parent) return;
    const started = fields[19];
    process.kill(pid, 'SIGSTOP');
    const children = (() => {
      try { return readFileSync(`/proc/${String(pid)}/task/${String(pid)}/children`, 'utf8').trim(); } catch { return ''; }
    })();
    for (const child of children.split(' ').filter(Boolean).map(Number)) stopProcess(child, pid);
    const current = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    if (current.slice(current.lastIndexOf(')') + 2).split(' ')[19] === started) process.kill(pid, 'SIGKILL');
  } catch {
    // The process ended while it was being stopped.
  }
}

/** Records the descendants of a live process before it can exit and reparent them. */
export function descendantsOf(pid: number): { pid: number; start: string }[] {
  try {
    const children = readFileSync(`/proc/${String(pid)}/task/${String(pid)}/children`, 'utf8').trim();
    return children.split(' ').filter(Boolean).map(Number).flatMap((child) => {
      try {
        const stat = readFileSync(`/proc/${String(child)}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const start = fields[19];
        return Number(fields[1]) === pid && start !== undefined ? [{ pid: child, start }, ...descendantsOf(child)] : [];
      } catch { return []; }
    });
  } catch { return []; }
}

/** Stops only descendants whose recorded PID still names the same process. */
export function stopDescendants(recorded: readonly { pid: number; start: string }[]): void {
  for (const { pid, start } of recorded.toReversed()) {
    try {
      const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === start) process.kill(pid, 'SIGKILL');
    } catch { /* The descendant already ended. */ }
  }
}

/** Names the file a test run records each process it starts in, one `<pid> <start time>` line each, for the leftovers check to read. */
export const PROCESS_RECORD_VARIABLE = 'AEOLUS_TEST_PROCESS_RECORD';

/** A process as /proc names it: its PID and its start time, so a reused PID is never taken for it. */
export interface RecordedProcess { readonly pid: number; readonly start: string }

/** The start time of the live process, none when it ended or is a zombie. */
export function startOf(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[0] === 'Z' ? undefined : fields[19];
  } catch { return undefined; }
}

/** Records the live process in the run's record, when the run names one, and says it as recorded. */
export function recordTestProcess(pid: number | undefined): RecordedProcess | undefined {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return undefined;
  const start = startOf(pid);
  if (start === undefined) return undefined;
  const record = process.env[PROCESS_RECORD_VARIABLE];
  if (record !== undefined && record !== '') appendFileSync(record, `${String(pid)} ${start}\n`);
  return { pid, start };
}

/** Kills the recorded process only while its PID still names it. */
export function killRecorded(recorded: RecordedProcess | undefined): void {
  if (recorded === undefined || startOf(recorded.pid) !== recorded.start) return;
  try { process.kill(recorded.pid, 'SIGKILL'); } catch { /* It ended meanwhile. */ }
}
