import { beforeEach, describe, expect, it } from 'vitest';

import type { DetectHarnesses } from './detect-harnesses.js';
import type { Detected, DetectedHarness, DetectedStore } from './ports.js';
import { createRefuseModel } from './refuse-model.js';

const BEFORE = new Date('2026-10-01T09:00:00.000Z');
const NOW = new Date('2026-10-09T15:00:00.000Z');

const CLAUDE_CODE: DetectedHarness = {
  version: '2.1.295',
  detectedAt: BEFORE,
  confirmedAt: BEFORE,
  options: { model: { values: { 'claude-opus-5-5': ['--model', 'claude-opus-5-5'], 'claude-sonnet-5-5': ['--model', 'claude-sonnet-5-5'] } } },
};

let held: Detected;
let saves: number;
const store: DetectedStore = {
  load: () => Promise.resolve(held),
  save: (detected) => {
    held = detected;
    saves += 1;
    return Promise.resolve();
  },
};
/** What the machine offers, as each change gave it. */
let given: Detected[];
let warnings: string[];
/** Each detection asked for, which detects nothing new: it keeps what is held. */
let detections: Parameters<DetectHarnesses>[0][];
let detect: DetectHarnesses;

function refuseModel() {
  return createRefuseModel({
    store,
    detect: (at) => detect(at),
    onDetected: (detected) => {
      given.push(detected);
    },
    logger: { warn: (message) => warnings.push(message) },
  });
}

beforeEach(() => {
  held = { 'claude-code': CLAUDE_CODE };
  saves = 0;
  given = [];
  warnings = [];
  detections = [];
  detect = (at) => {
    detections.push(at);
    return Promise.resolve(held);
  };
});

describe('a model a session refused (#382)', () => {
  it("keeps the id refused for its harness's detected version, and gives what the machine offers now", async () => {
    await refuseModel()({ harness: 'claude-code', id: 'claude-opus-5-5', at: NOW });

    const refused = { 'claude-code': { ...CLAUDE_CODE, refused: [{ id: 'claude-opus-5-5', at: NOW }] } };
    expect(held).toEqual(refused);
    expect(given[0]).toEqual(refused);
  });

  it('keeps an id refused once when it is refused again', async () => {
    await refuseModel()({ harness: 'claude-code', id: 'claude-opus-5-5', at: BEFORE });

    await refuseModel()({ harness: 'claude-code', id: 'claude-opus-5-5', at: NOW });

    expect(held['claude-code']?.refused).toEqual([{ id: 'claude-opus-5-5', at: BEFORE }]);
  });

  it('detects the harness again in the background, keeping the id refused, and gives what it found', async () => {
    await refuseModel()({ harness: 'claude-code', id: 'claude-opus-5-5', at: NOW });

    expect(detections).toEqual([{ harnesses: ['claude-code'], by: 'refusal' }]);
    await expect.poll(() => given.length).toBe(2);
  });

  it('keeps nothing refused for a harness detection never found', async () => {
    await refuseModel()({ harness: 'codex', id: 'gpt-5.6-sol', at: NOW });

    expect(saves).toBe(0);
    expect(detections).toEqual([]);
    expect(given).toEqual([]);
  });

  it('says so when detecting again fails, and keeps the id refused', async () => {
    detect = () => Promise.reject(new Error('claude timed out'));

    await refuseModel()({ harness: 'claude-code', id: 'claude-opus-5-5', at: NOW });

    await expect.poll(() => warnings).toEqual(['claude-code could not be detected again after it refused claude-opus-5-5: claude timed out']);
    expect(held['claude-code']?.refused).toEqual([{ id: 'claude-opus-5-5', at: NOW }]);
  });
});
