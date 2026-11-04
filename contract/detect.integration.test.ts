import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { aCrewingMachine, listedEntryOf, REPOSITORY, sessionOf } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, CLAUDE_CODE_VERSION, type Machine, type OtherHarness } from './support/machine.js';

// What a trierarch detects each harness offers, kept in detected.json and given by `aeolus-trierarch detect` (docs/trierarch.md, "Detected options").

const CREWED_WITHIN_MS = 30_000;
const TOLD_WITHIN_MS = 30_000;
/** Long enough for a trierarch that restarted to detect what it would. */
const PASSES_MS = 12_000;

/** What the stand-ins answer: Claude Code's aliases resolve to `claude-<alias>-5`, Codex's catalog holds one model, Copilot's help lists two. */
const CLAUDE_CODE_MODELS = ['claude-sonnet-5', 'claude-opus-5'];
const CODEX_VERSION = '0.163.0';
const COPILOT_VERSION = '1.0.105';

let fleet: Fleet;
let machine: Machine;

afterEach(async ({ task }) => {
  if (task.result?.state === 'fail') {
    console.log(`The service's log:\n${machine.serviceLog()}`);
  }
  await machine.remove();
  await fleet.close();
});

async function aCrewing(at: { others?: readonly OtherHarness[] } = {}): Promise<void> {
  fleet = await aFleet();
  machine = await aMachine(at);
  await aCrewingMachine({ fleet, machine });
}

const detectedFile = () => join(machine.trierarchHome, 'detected.json');
const optionSchema = z.object({ values: z.record(z.string(), z.array(z.string())), default: z.string().optional() });
const detectedSchema = z.record(
  z.string(),
  z.looseObject({
    version: z.string(),
    detectedAt: z.string(),
    confirmedAt: z.string().nullable(),
    options: z.record(z.string(), optionSchema),
    refused: z.array(z.object({ id: z.string(), at: z.string() })).optional(),
  }),
);
const detected = () => detectedSchema.parse(JSON.parse(readFileSync(detectedFile(), 'utf8')));
const helpCalls = () => machine.callsOf('claude').filter((line) => line === '--help').length;

async function restart(): Promise<void> {
  const ran = await machine.trierarch(['restart']);
  expect(ran.status, ran.stdout + ran.stderr).toBe(0);
}

/** Offers Copilot too, as an operator adds it to the configuration. */
function offerCopilot(): void {
  const file = join(machine.trierarchHome, 'config.json');
  const configuration = z.looseObject({ harnesses: z.record(z.string(), z.unknown()) }).parse(JSON.parse(readFileSync(file, 'utf8')));
  writeFileSync(file, JSON.stringify({ ...configuration, harnesses: { ...configuration.harnesses, copilot: { flags: [], options: {} } } }));
}

describe('init', () => {
  it("detects what each harness offers and keeps it in detected.json: its version, when its models were confirmed, its options and Claude Code's permission modes", async () => {
    await aCrewing({ others: ['codex'] });

    expect(detected()).toMatchObject({
      'claude-code': {
        version: CLAUDE_CODE_VERSION,
        confirmedAt: expect.any(String),
        options: {
          model: { values: { 'claude-sonnet-5': ['--model', 'claude-sonnet-5'], 'claude-opus-5': ['--model', 'claude-opus-5'] } },
          effort: { values: { low: ['--effort', 'low'], medium: ['--effort', 'medium'], high: ['--effort', 'high'] } },
        },
        permissionModes: ['acceptEdits', 'bypassPermissions', 'default', 'plan'],
      },
      codex: { version: CODEX_VERSION, confirmedAt: expect.any(String), options: { model: { values: { 'gpt-5.6-terra': ['-m', 'gpt-5.6-terra'] }, default: 'gpt-5.6-terra' } } },
    });
    expect(Object.keys(detected()['claude-code']?.options.model?.values ?? {})).toEqual(CLAUDE_CODE_MODELS);
  });

  it('says what each harness offers, one line per harness', async () => {
    fleet = await aFleet();
    machine = await aMachine();

    const init = await machine.trierarch(['init', '--fleet-url', fleet.url, '--ship-id', fleet.trierarchShip.shipId, '--secret', fleet.trierarchShip.secret, '--yes']);

    expect(init.status, init.stdout + init.stderr).toBe(0);
    expect(init.stdout).toMatch(new RegExp(`claude-code ${CLAUDE_CODE_VERSION}: model claude-sonnet-5, claude-opus-5; effort low, medium, high; models confirmed \\d{4}-\\d{2}-\\d{2}T`));
  });
});

describe('aeolus-trierarch detect', () => {
  it("gives each configured harness's version, when its models were confirmed and each option's values", async () => {
    await aCrewing({ others: ['copilot'] });
    offerCopilot();

    const ran = await machine.trierarch(['detect', '--json']);

    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual({
      harnesses: {
        'claude-code': { version: CLAUDE_CODE_VERSION, confirmedAt: expect.any(String), options: { model: CLAUDE_CODE_MODELS, effort: ['low', 'medium', 'high'] } },
        copilot: { version: COPILOT_VERSION, confirmedAt: null, options: { model: ['claude-sonnet-4.5', 'gpt-5', 'auto'] } },
      },
    });
  });

  it('says it in a line per harness, the default marked', async () => {
    await aCrewing({ others: ['copilot'] });
    offerCopilot();

    const ran = await machine.trierarch(['detect']);

    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(ran.stdout).toContain(`copilot ${COPILOT_VERSION}: model claude-sonnet-4.5, gpt-5, auto (default); no model confirmed`);
  });

  it('detects again though the version is the one detected', async () => {
    await aCrewing();
    const before = helpCalls();

    await machine.trierarch(['detect']);

    expect(helpCalls()).toBe(before + 1);
  });
});

describe('a start', () => {
  it('detects no harness whose version is the one detected', async () => {
    await aCrewing();
    const before = helpCalls();

    await restart();
    await wait(PASSES_MS);

    expect(helpCalls()).toBe(before);
  });

  it('detects again a harness whose version differs from the one detected', async () => {
    await aCrewing();
    const before = helpCalls();
    const found = detected();
    writeFileSync(detectedFile(), JSON.stringify({ ...found, 'claude-code': { ...found['claude-code'], version: '2.1.0' } }));

    await restart();

    await expect.poll(() => detected()['claude-code']?.version, { timeout: PASSES_MS }).toBe(CLAUDE_CODE_VERSION);
    expect(helpCalls()).toBe(before + 1);
  });

  it("tells argo once per version what detection could not find, such as Claude Code's --help naming no model alias", async () => {
    fleet = await aFleet();
    machine = await aMachine();
    machine.toggle('claude-help-names-no-alias', true);
    await aCrewingMachine({ fleet, machine });

    await expect.poll(async () => (await fleet.toldByTrierarch()).length, { timeout: TOLD_WITHIN_MS }).toBeGreaterThanOrEqual(1);
    await restart();
    await wait(PASSES_MS);

    await expect(fleet.toldByTrierarch()).resolves.toEqual([
      {
        to: 'argo',
        text: `claude-code ${CLAUDE_CODE_VERSION}: detection found a problem\n\nClaude Code ${CLAUDE_CODE_VERSION}'s --help names no model alias, so this machine declares no Claude Code model until an update of Claude Code names one`,
      },
    ]);
  });
});

describe('a crewed session', () => {
  it('starts with the flag of the model its settings picked, as detection found it', async () => {
    await aCrewing();
    const scout = await fleet.commission('scout');

    await fleet.crewInWorktree(scout, { repository: REPOSITORY, harness: 'claude-code', options: { model: 'claude-opus-5' } });

    await expect.poll(async () => (await listedEntryOf(machine, scout))?.state, { timeout: CREWED_WITHIN_MS }).toBe('running');
    expect(sessionOf(machine, 'scout').starts()[0]?.args.join(' ')).toContain('--model claude-opus-5');
  });
});

describe('a model a session refused', () => {
  /** Crews scout on the model, which its session refuses, and waits until detected.json keeps it refused. */
  async function aRefused(model: string): Promise<void> {
    machine.refuseModel(model);
    const scout = await fleet.commission('scout');
    await fleet.crewInWorktree(scout, { repository: REPOSITORY, harness: 'claude-code', options: { model } });
    await expect.poll(() => detected()['claude-code']?.refused?.map(({ id }) => id), { timeout: CREWED_WITHIN_MS }).toEqual([model]);
  }

  it('is kept refused in detected.json for the version detected', async () => {
    await aCrewing();

    await aRefused('claude-sonnet-5');

    expect(detected()['claude-code']).toMatchObject({ version: CLAUDE_CODE_VERSION, refused: [{ id: 'claude-sonnet-5', at: expect.any(String) }] });
  });

  it('is offered no more: a request picking it is given back, naming the models left', async () => {
    await aCrewing();
    await aRefused('claude-sonnet-5');
    const second = await fleet.commission('second');

    await fleet.crewInWorktree(second, { repository: REPOSITORY, harness: 'claude-code', options: { model: 'claude-sonnet-5' } });

    await expect.poll(() => fleet.givenBackReasonOf(second), { timeout: CREWED_WITHIN_MS }).toContain('options.model: model must be one of claude-opus-5');
  });

  it('is offered again once detect runs by hand, which clears the refused ids', async () => {
    await aCrewing();
    await aRefused('claude-sonnet-5');

    const ran = await machine.trierarch(['detect', '--json']);

    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(detected()['claude-code']?.refused ?? []).toEqual([]);
    expect(Object.keys(detected()['claude-code']?.options.model?.values ?? {})).toEqual(CLAUDE_CODE_MODELS);
  });
});

describe('config check', () => {
  it('refuses a configuration that sets a model option: model ids come from detection only', async () => {
    await aCrewing();
    const file = join(machine.trierarchHome, 'config.json');
    const configuration = z.looseObject({ harnesses: z.record(z.string(), z.looseObject({ options: z.record(z.string(), z.unknown()) })) }).parse(JSON.parse(readFileSync(file, 'utf8')));
    const claudeCode = configuration.harnesses['claude-code'];
    writeFileSync(file, JSON.stringify({ ...configuration, harnesses: { ...configuration.harnesses, 'claude-code': { ...claudeCode, options: { model: { values: { opus: ['--model', 'opus'] } } } } } }));

    const ran = await machine.trierarch(['config', 'check']);

    expect(ran.status).toBe(1);
    expect(ran.stdout + ran.stderr).toContain('sets a model option for claude-code: model ids come from detection only');
  });
});
