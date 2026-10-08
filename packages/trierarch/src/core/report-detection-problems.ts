import type { Detected, FleetPort } from './ports.js';

export type ReportDetectionProblems = (detected: Detected) => Promise<void>;

/**
 * Use case: tell argo what detection could not find (#365), such as Claude
 * Code naming no model alias. Each problem goes once per harness version: its
 * idempotency key names both, so the fleet stores it once however often the
 * trierarch starts.
 */
export function createReportDetectionProblems(deps: { fleet: Pick<FleetPort, 'reportToArgo'> }): ReportDetectionProblems {
  return async (detected) => {
    for (const [harness, found] of Object.entries(detected)) {
      if (found?.problem !== undefined) {
        await deps.fleet.reportToArgo({ text: found.problem, idempotencyKey: `trierarch:detection:${harness}:${found.version}` });
      }
    }
  };
}
