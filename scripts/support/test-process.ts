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

