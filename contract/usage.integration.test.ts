import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { aCrewingMachine, listedEntryOf, REPOSITORY, sessionOf } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine, type OtherHarness } from './support/machine.js';

// Each harness's usage in the trierarch's report (#353, docs/trierarch.md, "What a trierarch reports"): each crewed ship's tokens per model and login from its harness's transcripts, priced from the list prices, and each harness's subscription windows. Its tokens are read at start and then every 5 minutes, so a test writes a transcript while the trierarch is stopped and starts it again.

const CREWED_WITHIN_MS = 30_000;
const REPORTED_WITHIN_MS = 30_000;

let fleet: Fleet;
let machine: Machine;
let plugin: ShipId;

afterEach(async ({ task }) => {
  if (task.result?.state === 'fail') {
    console.log(`The service's log:\n${machine.serviceLog()}`);
  }
  await machine.remove();
  await fleet.close();
});

async function aMachineWith(others: readonly OtherHarness[], before: (machine: Machine) => void = () => undefined): Promise<void> {
  fleet = await aFleet();
  machine = await aMachine({ others });
  before(machine);
  plugin = await fleet.commission('trierarch-plugin');
  await aCrewingMachine({ fleet, machine, pluginShip: plugin });
}

/** Crews scout with the harness and waits until the trierarch lists it running. */
async function aRunningScoutOn(harness: string): Promise<ShipId> {
  const scout = await fleet.commission('scout');
  await fleet.crewInRepositories(scout, { main: REPOSITORY, harness });
  await expect.poll(async () => (await listedEntryOf(machine, scout))?.state, { timeout: CREWED_WITHIN_MS }).toBe('running');
  return scout;
}

/** Stops the trierarch, writes what the harness wrote meanwhile, and starts it again: it reads them at start. */
async function whileStopped(write: () => void): Promise<void> {
  const stop = await machine.trierarch(['stop']);
  expect(stop.status, stop.stdout + stop.stderr).toBe(0);
  write();
  const start = await machine.trierarch(['start']);
  expect(start.status, start.stdout + start.stderr).toBe(0);
}

function writeLines(file: string, lines: readonly unknown[]): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
}

const usageSchema = z.object({
  subscriptions: z.array(z.object({ harness: z.string(), readAt: z.string(), windows: z.array(z.object({ windowMinutes: z.number(), usedPercent: z.number(), resetsAt: z.string() })) })),
  ships: z.array(z.object({ shipId: z.string(), models: z.array(z.unknown()) })),
});

/** The usage the trierarch's report carries now; none before it carries one. */
async function reportedUsage(): Promise<z.infer<typeof usageSchema> | undefined> {
  const details = z.looseObject({ usage: z.unknown().optional() }).safeParse((await fleet.reportOfTrierarch())?.details);
  return details.success && details.data.usage !== undefined ? usageSchema.parse(details.data.usage) : undefined;
}

const shipModelsOf = async (shipId: ShipId): Promise<unknown> => (await reportedUsage())?.ships.find((ship) => ship.shipId === shipId)?.models;
const windowsOf = async (harness: string): Promise<unknown> => (await reportedUsage())?.subscriptions.find((subscription) => subscription.harness === harness)?.windows;

/** An assistant line of a Claude Code transcript, one per content block, each carrying its message's whole usage. */
function anAssistantLine(at: { id: string; model: string; timestamp: string; usage: Readonly<Record<string, number>> }): unknown {
  return { type: 'assistant', timestamp: at.timestamp, message: { id: at.id, model: at.model, usage: at.usage } };
}

describe("a ship's tokens", () => {
  it('are reported per model and login from its Claude Code transcripts and their sub-agents, each message once, priced from the list prices', async () => {
    await aMachineWith([]);
    const scout = await aRunningScoutOn('claude-code');
    const now = new Date().toISOString();
    const project = join(machine.home, '.claude', 'projects', sessionOf(machine, 'scout').folder.replace(/[^a-zA-Z0-9]/gu, '-'));

    await whileStopped(() => {
      const opus = { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 3000 };
      writeLines(join(project, 'conversation.jsonl'), [
        { type: 'user', timestamp: now, message: { role: 'user', content: 'Review PR 12' } },
        // A message of another crew, before the ship's folder was made: not counted.
        anAssistantLine({ id: 'msg_before', model: 'claude-opus-5-5', timestamp: '2020-01-01T00:00:00.000Z', usage: { input_tokens: 999_999, output_tokens: 999_999 } }),
        // One message in two content blocks: counted once.
        anAssistantLine({ id: 'msg_1', model: 'claude-opus-5-5', timestamp: now, usage: opus }),
        anAssistantLine({ id: 'msg_1', model: 'claude-opus-5-5', timestamp: now, usage: opus }),
        anAssistantLine({ id: 'msg_2', model: 'claude-opus-5-5', timestamp: now, usage: { input_tokens: 500, output_tokens: 1000 } }),
        // A message Claude Code made itself, no model answered: not counted.
        anAssistantLine({ id: 'msg_synthetic', model: '<synthetic>', timestamp: now, usage: { input_tokens: 7, output_tokens: 7 } }),
      ]);
      writeLines(join(project, 'conversation', 'subagents', 'agent-1.jsonl'), [
        anAssistantLine({ id: 'msg_3', model: 'claude-haiku-5-5', timestamp: now, usage: { input_tokens: 100_000, output_tokens: 200_000 } }),
        anAssistantLine({ id: 'msg_4', model: 'claude-not-priced-1', timestamp: now, usage: { input_tokens: 10, output_tokens: 20 } }),
      ]);
    });

    await expect
      .poll(() => shipModelsOf(scout), { timeout: REPORTED_WITHIN_MS })
      .toEqual([
        { model: 'claude-haiku-5-5', login: 'subscription', tokens: { input: 100_000, output: 200_000, cacheRead: 0, cacheWrite: 0 }, estimatedCostUsd: 0.11 },
        { model: 'claude-not-priced-1', login: 'subscription', tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 }, estimatedCostUsd: null },
        { model: 'claude-opus-5-5', login: 'subscription', tokens: { input: 1500, output: 3000, cacheRead: 10_000, cacheWrite: 3000 }, estimatedCostUsd: 0.09 },
      ]);
  });

  it("are reported per model and login from its Codex session logs, each turn what the session's total grew by, and Codex's subscription windows from the newest log", async () => {
    await aMachineWith(['codex']);
    const scout = await aRunningScoutOn('codex');
    const now = new Date().toISOString();
    const rateLimits = { primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1_798_000_000 }, secondary: { used_percent: 40, window_minutes: 10_080, resets_at: 1_798_500_000 } };

    await whileStopped(() => {
      writeLines(join(machine.home, '.codex', 'sessions', '2026', '11', '05', 'rollout-2026-11-05T10-00-00-scout.jsonl'), [
        { timestamp: now, type: 'session_meta', payload: { timestamp: now, cwd: sessionOf(machine, 'scout').folder } },
        { timestamp: now, type: 'turn_context', payload: { model: 'gpt-5.6-terra' } },
        { timestamp: now, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5000, cached_input_tokens: 3000, output_tokens: 400 } }, rate_limits: rateLimits } },
        { timestamp: now, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 9000, cached_input_tokens: 6000, output_tokens: 900 } }, rate_limits: rateLimits } },
      ]);
    });

    await expect
      .poll(() => shipModelsOf(scout), { timeout: REPORTED_WITHIN_MS })
      .toEqual([{ model: 'gpt-5.6-terra', login: 'subscription', tokens: { input: 3000, output: 900, cacheRead: 6000, cacheWrite: 0 }, estimatedCostUsd: 0.02 }]);
    await expect(windowsOf('codex')).resolves.toEqual([
      { windowMinutes: 300, usedPercent: 12.5, resetsAt: '2026-12-23T04:26:40.000Z' },
      { windowMinutes: 10_080, usedPercent: 40, resetsAt: '2026-12-28T23:20:00.000Z' },
    ]);
  });
});

describe("Claude Code's subscription", () => {
  it('is reported by its windows, from the rate limit event a short print-mode turn streams', async () => {
    const event = { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.256, resetsAt: 1_798_000_000 }, seven_day: { utilization: 0.5, resetsAt: 1_798_500_000 }, an_unknown_window: { utilization: 0.1, resetsAt: 1_798_000_000 } } } };

    await aMachineWith([], (each) => {
      each.streamRateLimitEvent(JSON.stringify(event));
    });

    await expect
      .poll(() => windowsOf('claude-code'), { timeout: REPORTED_WITHIN_MS })
      .toEqual([
        { windowMinutes: 300, usedPercent: 25.6, resetsAt: '2026-12-23T04:26:40.000Z' },
        { windowMinutes: 10_080, usedPercent: 50, resetsAt: '2026-12-28T23:20:00.000Z' },
      ]);
    expect(machine.callsOf('claude')).toContain('-p --model haiku --max-turns 1 --output-format stream-json --verbose Reply OK');
  });
});

const sentMessageSchema = z.object({
  hours: z.array(z.object({ hour: z.string(), ships: z.array(z.object({ shipId: z.string(), harness: z.string(), login: z.string().nullable(), models: z.array(z.object({ model: z.string(), tokens: z.looseObject({ output: z.number() }), estimatedCostUsd: z.record(z.string(), z.number()).nullable() })) })) })),
  subscriptions: z.array(z.unknown()),
  readAt: z.string(),
});

/** The usage messages sent to the plugin's ship, as common's schema shapes them, oldest first. */
async function usageSent(): Promise<z.infer<typeof sentMessageSchema>[]> {
  const sent = await fleet.usageSentByTrierarch();
  expect(sent.every(({ to }) => to === plugin)).toBe(true);
  return sent.map(({ message }) => sentMessageSchema.parse(message));
}

const outputOf = (messages: readonly z.infer<typeof sentMessageSchema>[], shipId: ShipId): number[] =>
  messages.flatMap(({ hours }) => hours.flatMap(({ ships }) => ships.filter((ship) => ship.shipId === shipId).flatMap(({ models }) => models.map(({ tokens }) => tokens.output))));

describe("a ship's usage sent to the trierarch plugin's ship", () => {
  it('goes at the first pass after the trierarch starts, per UTC hour with its login and its cost per kind of tokens', async () => {
    await aMachineWith([]);
    const scout = await aRunningScoutOn('claude-code');
    const now = new Date().toISOString();
    const project = join(machine.home, '.claude', 'projects', sessionOf(machine, 'scout').folder.replace(/[^a-zA-Z0-9]/gu, '-'));

    await whileStopped(() => {
      writeLines(join(project, 'conversation.jsonl'), [anAssistantLine({ id: 'msg_1', model: 'claude-opus-5-5', timestamp: now, usage: { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 3000 } })]);
    });

    await expect
      .poll(async () => (await usageSent()).flatMap(({ hours }) => hours.flatMap(({ ships }) => ships.filter((ship) => ship.shipId === scout).flatMap(({ harness, login, models }) => models.map((model) => ({ harness, login, ...model }))))), { timeout: REPORTED_WITHIN_MS })
      .toEqual([
        { harness: 'claude-code', login: 'subscription', model: 'claude-opus-5-5', tokens: { input: 1000, output: 2000, cacheRead: 10_000, cacheWrite: 3000 }, estimatedCostUsd: { input: 0.004, output: 0.04, cacheRead: 0.002, cacheWrite: 0.024 } },
      ]);
  });

  it("goes once more as the ship is released, with what it used since, before its worktree goes", async () => {
    await aMachineWith([]);
    const scout = await aRunningScoutOn('claude-code');
    const now = new Date().toISOString();
    const worktree = sessionOf(machine, 'scout').folder;
    const transcript = join(machine.home, '.claude', 'projects', worktree.replace(/[^a-zA-Z0-9]/gu, '-'), 'conversation.jsonl');
    await whileStopped(() => {
      writeLines(transcript, [anAssistantLine({ id: 'msg_1', model: 'claude-opus-5-5', timestamp: now, usage: { input_tokens: 10, output_tokens: 2000 } })]);
    });
    await expect.poll(async () => outputOf(await usageSent(), scout), { timeout: REPORTED_WITHIN_MS }).toEqual([2000]);

    appendFileSync(transcript, `${JSON.stringify(anAssistantLine({ id: 'msg_2', model: 'claude-opus-5-5', timestamp: now, usage: { input_tokens: 10, output_tokens: 500 } }))}\n`);
    await fleet.removeCrewRequest(scout);

    await expect.poll(() => existsSync(worktree), { timeout: CREWED_WITHIN_MS }).toBe(false);
    expect(outputOf(await usageSent(), scout)).toEqual([2000, 2500]);
  });
});
