import type { TrierarchReportDetails } from '@aeolus-fleet/common';

import { optionsSchemaOf } from './options-schema.js';
import type { TrierarchState } from './entry.js';
import type { FleetPort, ProcessPort, SelfReport, StatePort, TrierarchSetup } from './ports.js';

/** Reports the trierarch's own ship when something changed; the first call, at start, always reports. */
export type ReportSelf = () => Promise<void>;

/**
 * Use case: the trierarch reports as its own ship (docs/trierarch.md, "What
 * a trierarch reports"): working while a session runs, idle with none, a
 * note saying how many run of its cap and how many crashed, and its details
 * from its configuration and saved state. It reports on start, then only
 * when the report would differ from the last one it sent.
 */
export function createReportSelf(deps: { fleet: FleetPort; processes: ProcessPort; state: StatePort; setup: TrierarchSetup }): ReportSelf {
  let lastSent: string | undefined;
  return async () => {
    const state = await deps.state.load();
    const running = (await deps.processes.list()).filter((session) => session.status === 'running').length;
    const report = selfReportOf({ setup: deps.setup, state, running });
    const sent = JSON.stringify(report);
    if (sent === lastSent) {
      return;
    }
    await deps.fleet.reportSelf(report);
    lastSent = sent;
  };
}

function selfReportOf(at: { setup: TrierarchSetup; state: TrierarchState; running: number }): SelfReport {
  const { setup, state, running } = at;
  const crashed = Object.values(state.entries).filter((entry) => entry.state === 'crashed').length;
  const note = `${String(running)} of ${String(setup.configuration.caps.ships)} running${crashed > 0 ? `, ${String(crashed)} crashed` : ''}`;
  return { state: running > 0 ? 'working' : 'idle', note, details: detailsOf(setup, state) };
}

/** A flag's name, without a value given with `=`. */
function flagName(flag: string): string {
  return flag.split('=', 1)[0] ?? flag;
}

/** The trierarch's report details: what it offers from its configuration, the worktrees it kept and found, its version. */
function detailsOf(setup: TrierarchSetup, state: TrierarchState): TrierarchReportDetails {
  const { configuration, version } = setup;
  return {
    harnesses: Object.entries(configuration.harnesses).map(([harness, settings]) => ({
      harness,
      options: optionsSchemaOf(settings),
      flags: [...settings.flags],
      riskyFlags: settings.flags.filter((flag) => setup.riskyFlags[harness]?.includes(flagName(flag)) === true),
    })),
    workspaces: { repositories: Object.keys(configuration.repositories), folders: Object.keys(configuration.folders) },
    caps: configuration.caps,
    kept: state.kept.map(({ shipId, path }) => ({ shipId, path })),
    orphans: state.orphans.map((path) => ({ path })),
    ...(setup.machine === undefined || Object.keys(setup.machine).length === 0 ? {} : { machine: setup.machine }),
    version,
  };
}
