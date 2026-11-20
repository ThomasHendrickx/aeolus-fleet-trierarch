import { readFileSync } from 'node:fs';

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
