import { readFileSync } from 'node:fs';

import { type CommandResult, runCommand } from '../../src/adapters/run-command.js';

/**
 * Each test run's containers carry a label of their run, so a run that is
 * killed or times out before its afterAll leaves nothing the next run cannot
 * find (#345). The label sits on the test session image, and every container
 * started from it inherits it. A run is named by the process that runs the
 * suite and when it started, so the next run tells a run that ended from one
 * still going on the same machine, whose containers it leaves alone.
 */
export const TEST_RUN_LABEL = 'aeolus.trierarch.test-run';

declare module 'vitest' {
  export interface ProvidedContext {
    /** This run's value of the test run label. */
    trierarchTestRun: string;
  }
}

/** The start time field of `/proc/<pid>/stat`, counted after the command's closing parenthesis. */
const START_TIME_FIELD = 19;

/** When the process started, in clock ticks after boot; undefined once it runs no more. */
function startTimeOf(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[START_TIME_FIELD];
  } catch {
    return undefined;
  }
}

/** The run of the process that runs the suite. */
export function runOf(pid: number): string {
  return `${pid}-${startTimeOf(pid) ?? ''}`;
}

/** Whether the run is still going: its process runs, and is the same one. */
function isGoing(run: string): boolean {
  const pid = Number(run.split('-')[0]);
  return Number.isInteger(pid) && pid > 0 && runOf(pid) === run;
}

/** How the cleanup runs Podman: `runCommand`, or a stand-in that answers as Podman would. */
type RunPodman = (command: 'podman', options: { args: readonly string[] }) => Promise<CommandResult>;

/** The ids and runs of what carries the test run label, as `podman ps` or `podman images` lists them. */
async function labelled(podman: RunPodman, kind: 'ps' | 'images'): Promise<{ id: string; run: string }[]> {
  const listed = await podman('podman', { args: [kind, ...(kind === 'ps' ? ['--all'] : []), '--filter', `label=${TEST_RUN_LABEL}`, '--format', `{{.ID}} {{index .Labels "${TEST_RUN_LABEL}"}}`] });
  return listed.stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [id = '', run = ''] = line.split(' ');
      return { id, run };
    });
}

/** Removes the containers, with their volumes, and the test images of the runs the predicate picks. */
async function removeRuns(podman: RunPodman, isPicked: (run: string) => boolean): Promise<void> {
  const containers = (await labelled(podman, 'ps')).filter(({ run }) => isPicked(run)).map(({ id }) => id);
  if (containers.length > 0) {
    await podman('podman', { args: ['rm', '--force', '--volumes', '--time', '0', ...containers] });
  }
  const images = (await labelled(podman, 'images')).filter(({ run }) => isPicked(run)).map(({ id }) => id);
  if (images.length > 0) {
    await podman('podman', { args: ['image', 'rm', '--force', ...images] });
  }
}

/** Before a run starts: removes what every earlier run left, keeping what runs still going hold. */
export async function removeEarlierRuns(podman: RunPodman = runCommand): Promise<void> {
  await removeRuns(podman, (run) => !isGoing(run));
}

/** After a run ends: removes what it left, also of a test that failed. */
export async function removeRun(run: string, podman: RunPodman = runCommand): Promise<void> {
  await removeRuns(podman, (labelledRun) => labelledRun === run);
}
