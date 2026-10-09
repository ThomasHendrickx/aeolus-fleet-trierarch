import { describe, expect, it } from 'vitest';

import { InMemoryFleet } from '../../test/support/in-memory.js';
import { createReportDetectionProblems } from './report-detection-problems.js';

const AT = new Date('2026-10-08T15:00:00.000Z');
const PROBLEM = "Claude Code 2.1.293's --help names no model alias, so this machine declares no Claude Code model until an update of Claude Code names one";

describe("reporting detection's problems to argo (#365)", () => {
  it('tells argo each problem once per harness version, however often the trierarch starts', async () => {
    const fleet = new InMemoryFleet();
    const report = createReportDetectionProblems({ fleet });
    const detected = {
      'claude-code': { version: '2.1.293', detectedAt: AT, confirmedAt: null, options: {}, problem: PROBLEM },
      codex: { version: '0.160.1', detectedAt: AT, confirmedAt: AT, options: {} },
    };

    await report(detected);
    await report(detected);

    expect(fleet.toArgo).toEqual([{ text: PROBLEM, idempotencyKey: 'trierarch:detection:claude-code:2.1.293' }]);
  });
});
