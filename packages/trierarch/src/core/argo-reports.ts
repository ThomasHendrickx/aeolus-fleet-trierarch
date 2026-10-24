import { argoMessage } from '@aeolus-fleet/common';

import type { LowResource, MachineLoad } from './machine-load.js';

/**
 * What the trierarch tells argo or a ship's owner, in the shape the ship
 * protocol gives a message to argo: a headline naming the ship, then short facts in markdown.
 * The sender is the trierarch's own ship, named for its machine, so no text
 * names the machine again. Ids sit in the facts, never in the headline.
 */

/** A ship as the trierarch knows it: its name once the fleet told it. */
interface ShipNamed {
  readonly shipId: string;
  readonly shipName?: string | undefined;
}

/** At most this many of the discarded lines are named; the trierarch's log holds them all. */
const DISCARDED_NAMED_MAX = 5;

const nameOf = (ship: ShipNamed): string => ship.shipName ?? ship.shipId;

const shipFact = (ship: ShipNamed): string => (ship.shipName === undefined ? `- Ship: \`${ship.shipId}\`` : `- Ship: ${ship.shipName} (\`${ship.shipId}\`)`);

const paragraphs = (...parts: readonly string[]): string => parts.join('\n\n');

/**
 * The crash report, true for its reader (decision 0045): argo restarts the
 * ship in the console, so a person who owns it is told argo can.
 */
export function crashText(ship: ShipNamed, at: { exits: number; failedStart?: string; isForArgo: boolean }): string {
  const facts = [shipFact(ship), '- Status: crashed, its restart budget spent', ...(at.failedStart === undefined ? [] : [`- Its last start: ${at.failedStart}`])];
  return argoMessage({
    headline: `${nameOf(ship)} crashed ${String(at.exits)} times in an hour`,
    body: paragraphs(facts.join('\n'), at.isForArgo ? 'Restart it in the console to crew it again.' : 'argo can restart it in the console.'),
  });
}

/** What argo is told after the fleet refused a report to the ship's owner: the report, then why it came to argo. */
export function ownerUnreachableText(report: string, at: { ownerName: string; code: string; message: string }): string {
  return paragraphs(report, `Its owner ${at.ownerName} could not be reached: ${at.code}: ${at.message}.`);
}

export function discardedText(ship: ShipNamed, at: { isReleasedElsewhere: boolean; repository: string; unsaved: readonly string[] }): string {
  const lines = at.unsaved.map(discardedLine);
  const named = lines.slice(0, DISCARDED_NAMED_MAX).map(({ kind, what }) => `- ${kind} \`${what}\``);
  const more = lines.length - named.length;
  const list = [...named, ...(more > 0 ? [`- and ${String(more)} more, in this trierarch's log`] : [])].join('\n');
  const facts = [shipFact(ship), `- Worktree: ${at.repository}`, `- Discarded: ${countsOf(lines)}`].join('\n');
  const parts = at.isReleasedElsewhere ? ['The trierarch removed its worktree before crewing it again.', facts, list] : [facts, list];
  return argoMessage({
    headline: `${nameOf(ship)} released${at.isReleasedElsewhere ? ' elsewhere' : ''}: unpushed work discarded`,
    body: paragraphs(...parts),
  });
}

export function modelRefusedText(ship: ShipNamed, at: { harness: string; version: string; model: string }): string {
  return argoMessage({
    headline: `${at.harness} refused the model ${at.model} for ${nameOf(ship)}`,
    body: paragraphs(
      [shipFact(ship), `- Harness: ${at.harness} ${at.version}`, `- Model: ${at.model}`].join('\n'),
      'This machine offers the model no more at this version, until `aeolus-trierarch detect` runs by hand.',
    ),
  });
}

export function identityGoneText(ship: ShipNamed): string {
  return argoMessage({
    headline: `${nameOf(ship)} is no longer woken: its folder holds no identity`,
    body: paragraphs(shipFact(ship), 'The trierarch can no longer report on its behalf, watch its inbox or wake it. Restart it in the console to crew it again.'),
  });
}

export function settingsRefusedText(ship: ShipNamed, at: { settingsVersion: number; why: string }): string {
  return argoMessage({
    headline: `Cannot crew ${nameOf(ship)} with its settings`,
    body: [shipFact(ship), `- Settings version: ${String(at.settingsVersion)}`, `- Why: ${at.why}`].join('\n'),
  });
}

export function detectionProblemText(at: { harness: string; version: string; problem: string }): string {
  return argoMessage({ headline: `${at.harness} ${at.version}: detection found a problem`, body: at.problem });
}

const GIB = 1024 ** 3;
const GB = 1000 ** 3;
const PERCENT = 100;

/** Bytes as a reader counts them: memory in GiB, as the machine names it, a disk in GB, as its maker does. */
const gibOf = (bytes: number): string => (bytes / GIB).toFixed(1);
const gbOf = (bytes: number): string => (bytes / GB).toFixed(1);

/**
 * The machine is low on memory or disk (#400). The trierarch stops nothing
 * for it: freeing memory or disk is the operator's.
 */
export function lowResourceText(resource: LowResource, load: MachineLoad): string {
  const { memory, disk } = load;
  const headline =
    resource === 'memory'
      ? `Low on memory: ${String(Math.round((memory.availableBytes / memory.totalBytes) * PERCENT))} % available`
      : `Low on disk: ${String(Math.round((disk.freeBytes / disk.totalBytes) * PERCENT))} % free`;
  return argoMessage({
    headline,
    body: paragraphs([`- Memory: ${gibOf(memory.availableBytes)} of ${gibOf(memory.totalBytes)} GiB available`, `- Disk: ${gbOf(disk.freeBytes)} of ${gbOf(disk.totalBytes)} GB free`].join('\n'), 'The trierarch stops no session for it.'),
  });
}

/** The kinds of discarded lines, in the order the counts name them. */
const KINDS = ['deleted', 'changed', 'renamed', 'new', 'commit'] as const;
type DiscardedKind = (typeof KINDS)[number];

const COMMIT_PREFIX = 'commit ';
/** A git status line: two status letters and a space before the path. */
const STATUS_WIDTH = 3;

/** One line of what removing a worktree discards (git status, or an unkept commit), in words. */
function discardedLine(line: string): { kind: DiscardedKind; what: string } {
  if (line.startsWith(COMMIT_PREFIX)) {
    return { kind: 'commit', what: line.slice(COMMIT_PREFIX.length) };
  }
  const status = line.slice(0, 2);
  const what = line.slice(STATUS_WIDTH);
  if (status === '??' || status.includes('A')) {
    return { kind: 'new', what };
  }
  if (status.includes('D')) {
    return { kind: 'deleted', what };
  }
  if (status.includes('R')) {
    return { kind: 'renamed', what };
  }
  return { kind: 'changed', what };
}

function countsOf(lines: readonly { kind: DiscardedKind }[]): string {
  return KINDS.map((kind) => ({ kind, count: lines.filter((line) => line.kind === kind).length }))
    .filter(({ count }) => count > 0)
    .map(({ kind, count }) => (kind === 'commit' ? `${String(count)} ${count === 1 ? 'commit' : 'commits'}` : `${String(count)} ${kind}`))
    .join(', ');
}
