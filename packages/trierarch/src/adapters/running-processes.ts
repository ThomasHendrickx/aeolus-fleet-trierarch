import { runCommand } from './run-command.js';

/** A process running on this machine: its pid, its program and when it started. */
export interface RunningProcess {
  readonly pid: number;
  readonly program: string;
  readonly startedAt: Date;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A line of `ps -A -o pid=,etime=,comm=`: the elapsed time is `[[days-]hours:]minutes:seconds`. */
const LINE = /^\s*(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s+(.+)$/;

/** The processes `ps -A -o pid=,etime=,comm=` says, each started its elapsed time before `now`. */
export function processesOf(text: string, now: Date): RunningProcess[] {
  return text.split('\n').flatMap((line) => {
    const match = LINE.exec(line);
    if (match === null) {
      return [];
    }
    const [, pid, days, hours, minutes, seconds, program] = match;
    const elapsed = Number(days ?? 0) * DAY + Number(hours ?? 0) * HOUR + Number(minutes) * MINUTE + Number(seconds) * SECOND;
    return [{ pid: Number(pid), program: (program ?? '').trim(), startedAt: new Date(now.getTime() - elapsed) }];
  });
}

/** Every process running on this machine now, as macOS and Linux ps both say them. */
export async function runningProcesses(now: Date): Promise<RunningProcess[]> {
  const listed = await runCommand('ps', { args: ['-A', '-o', 'pid=,etime=,comm='] });
  if (listed.status !== 0) {
    throw new Error(`ps -A -o pid=,etime=,comm= failed: ${listed.stderr.trim()}`);
  }
  return processesOf(listed.stdout, now);
}
