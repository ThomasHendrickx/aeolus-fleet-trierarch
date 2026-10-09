import type { Detected, DetectedHarness, DetectedStore, HarnessDetector, Logger } from './ports.js';
import type { Clock } from './shared/clock.js';

/**
 * Why it detects: at start, only a harness whose version changed; by hand,
 * every harness, clearing the ids sessions refused; after a refusal, the
 * harness again, keeping them while its version is the same (#382).
 */
export type DetectedBy = 'start' | 'hand' | 'refusal';

export type DetectHarnesses = (at: { harnesses: readonly string[]; by: DetectedBy }) => Promise<Detected>;

/**
 * Use case: detect what the machine's harnesses offer (#365; docs/trierarch.md,
 * "Detected options"). A harness is detected when it has no detection yet,
 * when its version differs from the one detected, by hand, or after a
 * session refused a model, never more often: a probe costs a call. A harness whose CLI does not say its version,
 * or gives nothing to detect, keeps what was detected before, and the
 * operator is told. Only the harnesses given that have a detector are
 * detected; what was found is kept.
 */
export function createDetectHarnesses(deps: { detectors: Readonly<Record<string, HarnessDetector>>; store: DetectedStore; clock: Clock; logger: Pick<Logger, 'warn'> }): DetectHarnesses {
  return async ({ harnesses, by }) => {
    const before = await deps.store.load();
    const detected: Record<string, DetectedHarness | undefined> = { ...before };
    let isChanged = false;
    for (const name of harnesses) {
      const detector = deps.detectors[name];
      if (detector === undefined) {
        continue;
      }
      const previous = before[name];
      const version = await detector.version();
      if (version === undefined) {
        deps.logger.warn(`${name} did not say its version, so its options stay as detected before`);
        continue;
      }
      if (by === 'start' && previous?.version === version) {
        continue;
      }
      const found = await detector.detect({ version, previous, now: deps.clock.now() });
      if (found === undefined) {
        deps.logger.warn(`${name} ${version} gave nothing to detect, so its options stay as detected before`);
        continue;
      }
      const refused = by === 'refusal' && previous?.version === version ? previous.refused : undefined;
      detected[name] = refused === undefined ? found : { ...found, refused };
      isChanged = true;
    }
    if (isChanged) {
      await deps.store.save(detected);
    }
    return Object.fromEntries(harnesses.flatMap((name) => (detected[name] === undefined ? [] : [[name, detected[name]]])));
  };
}
