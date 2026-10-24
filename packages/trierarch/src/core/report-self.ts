import type { TrierarchReportDetails } from '@aeolus-fleet/common';

import { optionsSchemaOf } from './options-schema.js';
import type { TrierarchState } from './entry.js';
import { loadStepsOf } from './machine-load.js';
import type { FleetPort, SelfReport, SessionRuntime, StatePort, TrierarchSetup, TrustedPlaces, TrustPort } from './ports.js';
import type { ReadLoad } from './read-load.js';
import type { ReadUsage } from './read-usage.js';

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
 */
export function createReportSelf(deps: { fleet: FleetPort; processes: Pick<SessionRuntime, 'list' | 'stop'>; trust: TrustPort; state: StatePort; setup: TrierarchSetup; readLoad: ReadLoad; readUsage: ReadUsage }): ReportSelf {
  let lastSent: string | undefined;
  return async () => {
    const load = await deps.readLoad();
    const usage = await deps.readUsage();
    const state = await deps.state.load();
    const running = (await deps.processes.list()).filter((session) => session.status === 'running').length;
    const report = selfReportOf({ setup: deps.setup, state, running, trusted: await deps.trust.trusted() });
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

function selfReportOf(at: { setup: TrierarchSetup; state: TrierarchState; running: number; trusted: TrustedPlaces }): SelfReport {
  const { setup, state, running, trusted } = at;
  const crashed = Object.values(state.entries).filter((entry) => entry.state === 'crashed').length;
  const missing = state.missingPlugins ?? [];
  // A harness without its aeolus plugin cannot crew a ship (#1212): it is left out of the details, so no request is placed for it, and the note says why.
  const notOffered = missing.map((harness) => `, ${harness} not offered: its aeolus plugin is not installed (run aeolus-trierarch upgrade)`).join('');
  const note = `${String(running)} of ${String(setup.configuration.caps.ships)} running${crashed > 0 ? `, ${String(crashed)} crashed` : ''}${notOffered}`;
  return { state: running > 0 ? 'working' : 'idle', note, details: detailsOf(setup, { state, trusted }) };
}

/** A flag's name, without a value given with `=`. */
function flagName(flag: string): string {
  return flag.split('=', 1)[0] ?? flag;
}

/** The places every configured harness trusts: only those are offered (#381). */
function offeredOf(names: readonly string[], trustedBy: readonly (readonly string[])[]): string[] {
  return names.filter((name) => trustedBy.every((places) => places.includes(name)));
}

/** The trierarch's report details: what it offers from its configuration and what its harnesses trust, the worktrees it kept and found, its version. */
function detailsOf(setup: TrierarchSetup, at: { state: TrierarchState; trusted: TrustedPlaces }): TrierarchReportDetails {
  const { configuration, version } = setup;
  const { state, trusted } = at;
  const offered = Object.entries(configuration.harnesses).filter(([harness]) => state.missingPlugins?.includes(harness) !== true);
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
    caps: configuration.caps,
    // Paths stay on the machine: names only (decision 0032).
    kept: state.kept.map(({ shipId, repository }) => ({ shipId, repository })),
    orphans: state.orphans.map(({ repository, name }) => ({ repository, name })),
    ...(setup.machine === undefined || Object.keys(setup.machine).length === 0 ? {} : { machine: setup.machine }),
    // A fact for the console, never a label: placement does not read it (decision 0039).
    runtime: configuration.runtime?.kind ?? 'host',
    version,
  };
}
