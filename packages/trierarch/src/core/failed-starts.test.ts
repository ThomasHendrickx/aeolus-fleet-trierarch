import type { ShipId } from '@aeolus-fleet/common';
import { describe, expect, it } from 'vitest';

import { aTrierarch, CONFIGURATION, crewSettings, type Trierarch } from '../../test/support/in-memory.js';
import type { LaunchSeen } from './ports.js';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const NO_ACTIVITY = 'no activity within a minute of its start';
const STOPPED_REASON = `the starts of 3 ships failed in a row; last: ${NO_ACTIVITY}`;
const STOPPED_TEXT = [
  'Session starts fail here: this machine takes no new ships',
  '',
  '- Failed in a row: the starts of 3 ships',
  `- Last: ${NO_ACTIVITY}`,
  '',
  'It offers itself again for one start 10 minutes after its last failed start, and for good once a start succeeds or the trierarch starts with a changed configuration.',
].join('\n');
const DETECTED = { 'claude-code': { version: '2.1.295', detectedAt: new Date('2026-10-09T08:00:00Z'), confirmedAt: null, options: {} } };

/** A ship crewed by one pass, whose session shows what is given in its launch window, and the pass after its minute: its id. */
async function aStart(trierarch: Trierarch, at: { name: string; seen: LaunchSeen; settings?: Record<string, unknown> }) {
  const shipId = trierarch.fleet.commission(at.name);
  trierarch.harness.seen.set(shipId, at.seen);
  trierarch.fleet.request(shipId, crewSettings(at.settings ?? {}));
  await trierarch.pass();
  trierarch.clock.advance(MINUTE_MS);
  await trierarch.pass();
  return shipId;
}

/** The starts of the named ships fail in turn, each with no activity within its minute. */
async function failedStarts(trierarch: Trierarch, names: readonly string[]) {
  for (const name of names) {
    await aStart(trierarch, { name, seen: { kind: 'none' } });
  }
}

/** The harnesses its last report offers. */
async function offeredHarnesses(trierarch: Trierarch) {
  await trierarch.reportSelf();
  return trierarch.fleet.selfReports.at(-1)?.details.harnesses.map((each) => each.harness);
}

/** What argo was told, by text: the fleet keeps one report per idempotency key, so two of the same text were told apart. */
const toldArgo = (trierarch: Trierarch) => trierarch.fleet.toArgo.map((report) => report.text);

describe('a machine whose session starts keep failing stops offering itself (aeolus-fleet#853)', () => {
  it('offers no harness and no place once the starts of 3 ships failed in a row, naming each harness with the last reason, and says so in its note', async () => {
    const trierarch = aTrierarch();

    await failedStarts(trierarch, ['scout', 'lookout', 'helm']);
    await trierarch.reportSelf();

    const report = trierarch.fleet.selfReports.at(-1);
    expect(report?.details.harnesses).toEqual([]);
    expect(report?.details.workspaces).toEqual({ repositories: [], folders: [] });
    expect(report?.details.notOffered).toEqual([{ harness: 'claude-code', reason: STOPPED_REASON }]);
    expect(report?.note).toBe(`0 of 8 running, not offered: ${STOPPED_REASON}`);
  });

  it('still offers itself after the starts of 2 ships failed', async () => {
    const trierarch = aTrierarch();

    await failedStarts(trierarch, ['scout', 'lookout']);

    expect(await offeredHarnesses(trierarch)).toEqual(['claude-code']);
  });

  it('tells argo once, with the last reason', async () => {
    const trierarch = aTrierarch();

    await failedStarts(trierarch, ['scout', 'lookout', 'helm', 'bosun']);

    expect(toldArgo(trierarch)).toEqual([STOPPED_TEXT]);
  });

  it('counts the failed starts of one ship once, so the failures of one ship\'s settings never stop the machine', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    trierarch.harness.isFailingLaunch = true;
    trierarch.fleet.request(shipId, crewSettings());

    await trierarch.pass();
    await trierarch.pass();
    await trierarch.pass();
    trierarch.harness.isFailingLaunch = false;
    await failedStarts(trierarch, ['lookout']);

    expect(await offeredHarnesses(trierarch)).toEqual(['claude-code']);
    expect(toldArgo(trierarch)).toEqual([]);
  });

  it('counts a crew that failed as a failed start', async () => {
    const trierarch = aTrierarch();
    trierarch.harness.isFailingLaunch = true;

    for (const name of ['scout', 'lookout', 'helm']) {
      trierarch.fleet.request(trierarch.fleet.commission(name), crewSettings());
      await trierarch.pass();
    }

    expect(await offeredHarnesses(trierarch)).toEqual([]);
  });

  it("counts a refusal of the harness's own default model as a failed start", async () => {
    const trierarch = aTrierarch(CONFIGURATION, DETECTED);

    for (const name of ['scout', 'lookout', 'helm']) {
      await aStart(trierarch, { name, seen: { kind: 'refused', model: 'claude-opus-5-5' } });
    }

    expect(await offeredHarnesses(trierarch)).toEqual([]);
  });

  it('counts nothing for a refusal of a model the settings picked: the settings are at fault', async () => {
    const trierarch = aTrierarch(CONFIGURATION, DETECTED);

    for (const name of ['scout', 'lookout', 'helm']) {
      await aStart(trierarch, { name, seen: { kind: 'refused', model: 'sonnet' }, settings: { options: { model: 'sonnet' } } });
    }

    expect(await offeredHarnesses(trierarch)).toEqual(['claude-code']);
  });

  it("counts a restart's first minute without activity as a failed start", async () => {
    const trierarch = aTrierarch();
    const scout = await aStart(trierarch, { name: 'scout', seen: { kind: 'active' } });
    await failedStarts(trierarch, ['lookout', 'helm']);
    trierarch.harness.seen.set(scout, { kind: 'none' });
    trierarch.processes.exit(scout);
    await trierarch.pass();
    trierarch.clock.advance(5 * SECOND_MS);
    await trierarch.pass();

    trierarch.clock.advance(MINUTE_MS);
    await trierarch.pass();

    expect(await offeredHarnesses(trierarch)).toEqual([]);
  });

  it('counts afresh after a start succeeds', async () => {
    const trierarch = aTrierarch();
    await failedStarts(trierarch, ['scout', 'lookout']);
    await aStart(trierarch, { name: 'helm', seen: { kind: 'active' } });

    await failedStarts(trierarch, ['bosun', 'purser']);

    expect(await offeredHarnesses(trierarch)).toEqual(['claude-code']);
  });

  it('offers itself again, as a probe, 10 minutes after its last failed start, and not before', async () => {
    const trierarch = aTrierarch();
    await failedStarts(trierarch, ['scout', 'lookout', 'helm']);

    trierarch.clock.advance(10 * MINUTE_MS - SECOND_MS);
    const before = await offeredHarnesses(trierarch);
    trierarch.clock.advance(SECOND_MS);
    const probe = await offeredHarnesses(trierarch);

    expect({ before, probe }).toEqual({ before: [], probe: ['claude-code'] });
  });

  it('stops offering itself again for 10 minutes when its probe start fails, telling argo nothing new', async () => {
    const trierarch = aTrierarch();
    await failedStarts(trierarch, ['scout', 'lookout', 'helm']);
    trierarch.clock.advance(10 * MINUTE_MS);

    await failedStarts(trierarch, ['bosun']);
    const stoppedAgain = await offeredHarnesses(trierarch);
    trierarch.clock.advance(10 * MINUTE_MS);
    const probeAgain = await offeredHarnesses(trierarch);

    expect({ stoppedAgain, probeAgain }).toEqual({ stoppedAgain: [], probeAgain: ['claude-code'] });
    expect(toldArgo(trierarch)).toEqual([STOPPED_TEXT]);
  });

  it('offers itself for good once a start succeeds, and tells argo again when it stops again later', async () => {
    const trierarch = aTrierarch();
    await failedStarts(trierarch, ['scout', 'lookout', 'helm']);
    trierarch.clock.advance(10 * MINUTE_MS);
    await aStart(trierarch, { name: 'bosun', seen: { kind: 'active' } });

    await failedStarts(trierarch, ['purser', 'cook']);
    const offered = await offeredHarnesses(trierarch);
    await failedStarts(trierarch, ['gunner']);

    expect(offered).toEqual(['claude-code']);
    expect(toldArgo(trierarch)).toEqual([STOPPED_TEXT, STOPPED_TEXT]);
  });

  it('offers itself again when a start of a ship it holds succeeds while it does not offer itself', async () => {
    const trierarch = aTrierarch();
    const scout = await aStart(trierarch, { name: 'scout', seen: { kind: 'active' } });
    await failedStarts(trierarch, ['lookout', 'helm', 'bosun']);
    trierarch.processes.exit(scout);
    await trierarch.pass();
    trierarch.clock.advance(5 * SECOND_MS);
    await trierarch.pass();

    await trierarch.pass();

    expect(await offeredHarnesses(trierarch)).toEqual(['claude-code']);
  });

  it('keeps not offering itself across a restart of the trierarch with the same configuration', async () => {
    const trierarch = aTrierarch();
    await failedStarts(trierarch, ['scout', 'lookout', 'helm']);
    const restarted = aTrierarch();
    await restarted.state.save(trierarch.state.current());

    await restarted.pass();

    expect(await offeredHarnesses(restarted)).toEqual([]);
  });

  it('offers itself again once the trierarch starts with a changed configuration', async () => {
    const trierarch = aTrierarch();
    await failedStarts(trierarch, ['scout', 'lookout', 'helm']);
    const changed = aTrierarch({ ...CONFIGURATION, caps: { ships: 6, running: 4 } });
    await changed.state.save(trierarch.state.current());

    await changed.pass();

    expect(await offeredHarnesses(changed)).toEqual(['claude-code']);
  });

  it('goes on with the requests it holds while it does not offer itself', async () => {
    const trierarch = aTrierarch();
    await failedStarts(trierarch, ['scout', 'lookout', 'helm']);
    const held: ShipId = trierarch.fleet.commission('bosun');
    trierarch.fleet.request(held, crewSettings());

    await trierarch.pass();

    expect(trierarch.harness.launches.map((launch) => launch.shipId)).toContain(held);
  });
});
