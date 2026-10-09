import type { DetectHarnesses } from './detect-harnesses.js';
import type { Detected, DetectedStore, Logger } from './ports.js';

/** Keeps a model a session refused as refused, so the machine offers it no more (#382). */
export type RefuseModel = (refused: { harness: string; id: string; at: Date }) => Promise<void>;

/**
 * Use case: a session refused the model it launched with (#382). The id is
 * kept refused for its harness's detected version, and what the machine
 * offers now is given at once, so the next pass and the next report offer it
 * no more. Then the harness is detected again in the background, keeping the
 * id refused, and what that finds is given too: the loop never waits on a
 * probe. A harness detection never found has no models to refuse.
 */
export function createRefuseModel(deps: { store: DetectedStore; detect: DetectHarnesses; onDetected: (detected: Detected) => void; logger: Pick<Logger, 'warn'> }): RefuseModel {
  return async ({ harness, id, at }) => {
    const before = await deps.store.load();
    const found = before[harness];
    if (found === undefined) {
      return;
    }
    const refused = found.refused ?? [];
    const detected = refused.some((each) => each.id === id) ? before : { ...before, [harness]: { ...found, refused: [...refused, { id, at }] } };
    if (detected !== before) {
      await deps.store.save(detected);
    }
    deps.onDetected(detected);
    void deps
      .detect({ harnesses: [harness], by: 'refusal' })
      .then(async () => {
        deps.onDetected(await deps.store.load());
      })
      .catch((error: unknown) => {
        deps.logger.warn(`${harness} could not be detected again after it refused ${id}: ${error instanceof Error ? error.message : String(error)}`);
      });
  };
}
