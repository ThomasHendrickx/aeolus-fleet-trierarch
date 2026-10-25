import type { TrierarchReportDetails } from '@aeolus-fleet/common';

import { optionsSchemaOf } from './options-schema.js';
import type { TrierarchState } from './entry.js';
import { isOffering, isProbing, notOfferedReason, probeShipsCap } from './failed-starts.js';
import { loadStepsOf } from './machine-load.js';
import type { FleetPort, SelfReport, SessionRuntime, StatePort, TrierarchSetup, TrustedPlaces, TrustPort } from './ports.js';
import type { ReadLoad } from './read-load.js';
import type { ReadUsage } from './read-usage.js';
import type { Clock } from './shared/clock.js';

const PLUGIN_MISSING_REASON = 'its aeolus-fleet plugin is not installed (run aeolus-trierarch upgrade)';

/** Reports the trierarch's own ship when something changed; the first call, at start, always reports. */
export type ReportSelf = () => Promise<void>;

/**
 * Use case: the trierarch reports as its own ship (docs/trierarch.md, "What
 * a trierarch reports"): working while a session runs, idle with none, a
 * note saying how many run of its cap and how many crashed, and its details
 * from its configuration and saved state, with its machine's load (#400)
 * and its harnesses' usage (#353) as last read. It reports on start, then
 * only when the report would differ from the last one it sent; the load
 * counts as changed only once it takes another step, as it always moves.
 * A machine whose session starts keep failing offers nothing (#853) until
 * its probe is due.
 */
export function createReportSelf(deps: { fleet: FleetPort; processes: Pick<SessionRuntime, 'list' | 'stop'>; trust: TrustPort; state: StatePort; setup: TrierarchSetup; readLoad: ReadLoad; readUsage: ReadUsage; clock: Clock }): ReportSelf {
  let lastSent: string | undefined;
  return async () => {
    const load = await deps.readLoad();
    const usage = await deps.readUsage();
    const state = await deps.state.load();
    const running = (await deps.processes.list()).filter((session) => session.status === 'running').length;
    const report = selfReportOf({ setup: deps.setup, state, running, trusted: await deps.trust.trusted(), now: deps.clock.now() });
    const withUsage: SelfReport = { ...report, details: { ...report.details, ...(load !== undefined && { load }), usage } };
    // What makes it another report: the load by its steps only.
    const sent = JSON.stringify({ ...withUsage, details: { ...withUsage.details, load: load === undefined ? undefined : loadStepsOf(load) } });
    if (sent === lastSent) {
      return;
    }
    await deps.fleet.reportSelf(withUsage);
    lastSent = sent;
  };
}

function selfReportOf(at: { setup: TrierarchSetup; state: TrierarchState; running: number; trusted: TrustedPlaces; now: Date }): SelfReport {
  const { setup, state, running, trusted, now } = at;
  const crashed = Object.values(state.entries).filter((entry) => entry.state === 'crashed').length;
  const missing = state.missingPlugins ?? [];
  const stopped = stoppedReasonOf(state, now);
  // A harness without its aeolus-fleet plugin cannot crew a ship (#1212): it is left out of the details, so no request is placed for it, and the note says why.
  const notOfferedNote = missing.map((harness) => `, ${harness} not offered: ${PLUGIN_MISSING_REASON}`).join('') + (stopped === undefined ? '' : `, not offered: ${stopped}`);
  const note = `${String(running)} of ${String(setup.configuration.caps.ships)} running${crashed > 0 ? `, ${String(crashed)} crashed` : ''}${notOfferedNote}`;
  return { state: running > 0 ? 'working' : 'idle', note, details: detailsOf(setup, { state, trusted, stopped, isProbe: isProbing(state.failedStarts, now) }) };
}

/** Why the machine offers itself for no placement now (#853), or none while it offers itself. */
function stoppedReasonOf(state: TrierarchState, now: Date): string | undefined {
  const { failedStarts } = state;
  return failedStarts === undefined || isOffering(failedStarts, now) ? undefined : notOfferedReason(failedStarts);
}

/** A flag's name, without a value given with `=`. */
function flagName(flag: string): string {
  return flag.split('=', 1)[0] ?? flag;
}

/** The places every offered harness trusts: only those are offered (#381), and none without a harness to crew them. */
function offeredOf(names: readonly string[], trustedBy: readonly (readonly string[])[]): string[] {
  return trustedBy.length === 0 ? [] : names.filter((name) => trustedBy.every((places) => places.includes(name)));
}

/**
 * The trierarch's report details: what it offers from its configuration and
 * what its harnesses trust, the worktrees it kept and found, its version. A
 * machine that stopped offering itself (#853) offers no harness, and so no
 * place, naming each harness with why; in its probe it has room for one
 * start only.
 */
function detailsOf(setup: TrierarchSetup, at: { state: TrierarchState; trusted: TrustedPlaces; stopped: string | undefined; isProbe: boolean }): TrierarchReportDetails {
  const { configuration, version } = setup;
  const { state, trusted, stopped, isProbe } = at;
  const missing = state.missingPlugins ?? [];
  const reasonOf = (harness: string): string | undefined => (missing.includes(harness) ? PLUGIN_MISSING_REASON : stopped);
  const notOffered = Object.keys(configuration.harnesses).flatMap((harness) => {
    const reason = reasonOf(harness);
    return reason === undefined ? [] : [{ harness, reason }];
  });
  const offered = Object.entries(configuration.harnesses).filter(([harness]) => reasonOf(harness) === undefined);
  const byHarness = offered.map(([harness]) => harness).map((harness) => trusted[harness] ?? { repositories: [], folders: [] });
  return {
    harnesses: offered.map(([harness, settings]) => {
      const detected = setup.detected?.[harness];
      return {
        harness,
        options: optionsSchemaOf(settings),
        flags: [...settings.flags],
        riskyFlags: settings.flags.filter((flag) => setup.riskyFlags[harness]?.includes(flagName(flag)) === true),
        ...(detected !== undefined && { version: detected.version, modelsConfirmedAt: detected.confirmedAt?.toISOString() ?? null }),
      };
    }),
    workspaces: {
      repositories: offeredOf(
        Object.keys(configuration.repositories),
        byHarness.map((places) => places.repositories),
      ),
      folders: offeredOf(
        Object.keys(configuration.folders),
        byHarness.map((places) => places.folders),
      ),
    },
    ...(notOffered.length > 0 && { notOffered }),
    caps: isProbe ? { ...configuration.caps, ships: probeShipsCap(Object.values(state.entries), configuration.caps.ships) } : configuration.caps,
    // Paths stay on the machine: names only (decision 0032).
    kept: state.kept.map(({ shipId, repository }) => ({ shipId, repository })),
    orphans: state.orphans.map(({ repository, name }) => ({ repository, name })),
    ...(setup.machine === undefined || Object.keys(setup.machine).length === 0 ? {} : { machine: setup.machine }),
    // A fact for the console, never a label: placement does not read it (decision 0039).
    runtime: configuration.runtime?.kind ?? 'host',
    version,
  };
}
