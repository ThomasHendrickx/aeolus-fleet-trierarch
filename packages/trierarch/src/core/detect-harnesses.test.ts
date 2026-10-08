import { beforeEach, describe, expect, it } from 'vitest';

import { createDetectHarnesses } from './detect-harnesses.js';
import type { Detected, DetectedHarness, DetectedStore, HarnessDetector } from './ports.js';

const BEFORE = new Date('2026-10-01T09:00:00.000Z');
const NOW = new Date('2026-10-08T15:00:00.000Z');

function aDetection(version: string, at: Date): DetectedHarness {
  return { version, detectedAt: at, confirmedAt: at, options: { model: { values: { [`model-${version}`]: ['--model', `model-${version}`] } } } };
}

/** A harness CLI at a version, which detects what `found` says; counts its detections. */
function aDetector(at: { version: string | undefined; found?: (version: string) => DetectedHarness | undefined }): HarnessDetector & { detections: { version: string; previous: DetectedHarness | undefined }[] } {
  const detections: { version: string; previous: DetectedHarness | undefined }[] = [];
  return {
    detections,
    version: () => Promise.resolve(at.version),
    detect: ({ version, previous, now }) => {
      detections.push({ version, previous });
      return Promise.resolve(at.found === undefined ? aDetection(version, now) : at.found(version));
    },
  };
}

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
let warnings: string[];
const logger = {
  warn: (message: string) => {
    warnings.push(message);
  },
};

function detectWith(detectors: Record<string, HarnessDetector>) {
  return createDetectHarnesses({ detectors, store, clock: { now: () => NOW }, logger });
}

beforeEach(() => {
  held = {};
  saves = 0;
  warnings = [];
});

describe('detecting the harnesses of a machine (#365)', () => {
  it('detects a harness it has no detection for yet, and keeps what it found', async () => {
    const detected = await detectWith({ 'claude-code': aDetector({ version: '2.1.293' }) })({ harnesses: ['claude-code'], isForced: false });

    expect(detected).toEqual({ 'claude-code': aDetection('2.1.293', NOW) });
    expect(held).toEqual(detected);
  });

  it('detects nothing again while the harness is at the version it detected', async () => {
    held = { 'claude-code': aDetection('2.1.293', BEFORE) };
    const claude = aDetector({ version: '2.1.293' });

    const detected = await detectWith({ 'claude-code': claude })({ harnesses: ['claude-code'], isForced: false });

    expect(claude.detections).toEqual([]);
    expect(detected).toEqual({ 'claude-code': aDetection('2.1.293', BEFORE) });
    expect(saves).toBe(0);
  });

  it('detects again once the harness updated, given what it detected before', async () => {
    held = { 'claude-code': aDetection('2.1.293', BEFORE) };
    const claude = aDetector({ version: '2.1.300' });

    const detected = await detectWith({ 'claude-code': claude })({ harnesses: ['claude-code'], isForced: false });

    expect(claude.detections).toEqual([{ version: '2.1.300', previous: aDetection('2.1.293', BEFORE) }]);
    expect(detected).toEqual({ 'claude-code': aDetection('2.1.300', NOW) });
  });

  it('detects again when asked by hand, though the version is the same', async () => {
    held = { 'claude-code': aDetection('2.1.293', BEFORE) };
    const claude = aDetector({ version: '2.1.293' });

    await detectWith({ 'claude-code': claude })({ harnesses: ['claude-code'], isForced: true });

    expect(claude.detections).toHaveLength(1);
  });

  it('keeps what it detected before when the CLI does not say its version, and says so', async () => {
    held = { 'claude-code': aDetection('2.1.293', BEFORE) };

    const detected = await detectWith({ 'claude-code': aDetector({ version: undefined }) })({ harnesses: ['claude-code'], isForced: false });

    expect(detected).toEqual({ 'claude-code': aDetection('2.1.293', BEFORE) });
    expect(warnings).toEqual(['claude-code did not say its version, so its options stay as detected before']);
  });

  it('keeps what it detected before when detecting finds nothing, and says so', async () => {
    held = { codex: aDetection('0.160.1', BEFORE) };

    const detected = await detectWith({ codex: aDetector({ version: '0.161.0', found: () => undefined }) })({ harnesses: ['codex'], isForced: false });

    expect(detected).toEqual({ codex: aDetection('0.160.1', BEFORE) });
    expect(warnings).toEqual(['codex 0.161.0 gave nothing to detect, so its options stay as detected before']);
  });

  it('detects only the harnesses it is given that have a detector', async () => {
    const claude = aDetector({ version: '2.1.293' });
    const codex = aDetector({ version: '0.160.1' });

    const detected = await detectWith({ 'claude-code': claude, codex })({ harnesses: ['claude-code', 'gemini'], isForced: false });

    expect(Object.keys(detected)).toEqual(['claude-code']);
    expect(codex.detections).toEqual([]);
  });
});
