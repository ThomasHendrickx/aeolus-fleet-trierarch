import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import type { Fleet } from './fleet.js';
import type { Machine } from './machine.js';

/** The repository's name in the configuration, as a crew request names it. */
export const REPOSITORY = 'aeolus-fleet';

/** The trierarch plugin's setup line for the fleet's trierarch ship; with `pluginShip`, it names the trierarch plugin's ship the trusted repositories come from. */
export function setupLineOf(fleet: Fleet, pluginShip?: string): string[] {
  return ['init', '--fleet-url', fleet.url, '--ship-id', fleet.trierarchShip.shipId, '--secret', fleet.trierarchShip.secret, ...(pluginShip === undefined ? [] : ['--plugin-ship-id', pluginShip]), '--yes'];
}

/** Sets the machine up as the trierarch plugin's setup line does, then adds the repository: the service runs and can crew a request in it. With `as`, another trierarch than the one under test does. */
export async function aCrewingMachine(at: { fleet: Fleet; machine: Machine; as?: readonly string[]; pluginShip?: string }): Promise<void> {
  const { fleet, machine } = at;
  for (const words of [setupLineOf(fleet, at.pluginShip), ['add', 'repository', REPOSITORY, machine.repository]]) {
    const ran = await machine.trierarch(words, at.as === undefined ? {} : { as: at.as });
    if (ran.status !== 0) {
      throw new Error(`aeolus-trierarch ${words[0] ?? ''} failed: ${ran.stdout}${ran.stderr}`);
    }
  }
}

const startSchema = z.object({ args: z.array(z.string()), env: z.record(z.string(), z.string()), pid: z.number() });
const turnSchema = z.object({ prompt: z.string(), context: z.string() });

function linesOf<T>(file: string, schema: z.ZodType<T>): T[] {
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => schema.parse(JSON.parse(line)))
    : [];
}

/** A ship's session in its worktree, as the harness's stand-in writes it down: each start, and for Claude Code each turn with what the plugin's hooks added to it. */
export function sessionOf(machine: Machine, shipName: string) {
  const worktree = join(machine.trierarchHome, 'worktrees', REPOSITORY, shipName);
  return {
    worktree,
    starts: () => linesOf(join(worktree, 'fake-starts.jsonl'), startSchema),
    turns: () => linesOf(join(worktree, 'fake-turns.jsonl'), turnSchema),
  };
}

const listedSchema = z.array(z.object({ shipId: z.string(), state: z.string(), restarts: z.number() }));

/** The ship's entry as `list --json` says it: its state and how often it restarted; none when the trierarch lists no such ship. */
export async function listedEntryOf(machine: Machine, shipId: string): Promise<{ state: string; restarts: number } | undefined> {
  const list = await machine.trierarch(['list', '--json']);
  return list.status === 0 ? listedSchema.parse(JSON.parse(list.stdout)).find((entry) => entry.shipId === shipId) : undefined;
}

/** Whether a process with the pid runs. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
