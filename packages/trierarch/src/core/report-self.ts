import type { TrierarchReportDetails } from '@aeolus-fleet/common';

import { optionsSchemaOf } from './options-schema.js';
import type { TrierarchState } from './entry.js';
import { loginOf, type KeyStateAt, type Logins } from './login.js';
import { isOffering, isProbing, notOfferedReason, probeShipsCap } from './failed-starts.js';
import { loadStepsOf } from './machine-load.js';
import type { FleetKeyPort, FleetPort, ModelLoginsPort, SelfReport, SessionRuntime, StatePort, TrierarchSetup, TrustedPlaces, TrustPort } from './ports.js';
import type { ReadLoad } from './read-load.js';
import type { ReadUsage } from './read-usage.js';
import type { Clock } from './shared/clock.js';

/** What the trierarch's report says while the fleet refuses to receive for lack of its key (decision 0068). */
const KEY_CUT_OFF_NOTE = "waiting for the fleet's key (KEY_UNAVAILABLE)";

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
 * its probe is due. Each harness's login says its default and its key's
 * state, never the key (api keys K7, K8). While the fleet's key is cut off it
 * is blocked and says it waits for the key (decision 0068).
 */
export function createReportSelf(deps: {
  fleetKey: FleetKeyPort;
  fleet: FleetPort;
  processes: Pick<SessionRuntime, 'list' | 'stop'>;
  trust: TrustPort;
  state: StatePort;
  setup: TrierarchSetup;
  readLoad: ReadLoad;
  readUsage: ReadUsage;
  clock: Clock;
  modelLogins: Pick<ModelLoginsPort, 'keyState'>;
  logins?: Logins;
}): ReportSelf {
  let lastSent: string | undefined;
  return async () => {
    const load = await deps.readLoad();
    const usage = await deps.readUsage();
    const state = await deps.state.load();
    const running = (await deps.processes.list()).filter((session) => session.status === 'running').length;
    const keys = new Map(await Promise.all(Object.keys(deps.setup.configuration.harnesses).map(async (harness) => [harness, await deps.modelLogins.keyState(harness)] as const)));
    const report = selfReportOf({ setup: deps.setup, state, running, trusted: await deps.trust.trusted(), now: deps.clock.now(), logins: { ...(deps.logins !== undefined && { configured: deps.logins }), keys } });
    const blocked: SelfReport = deps.fleetKey.isCutOff() ? { ...report, state: 'blocked', note: `${report.note}, ${KEY_CUT_OFF_NOTE}` } : report;
    const withUsage: SelfReport = { ...blocked, details: { ...report.details, ...(load !== undefined && { load }), usage } };
    // What makes it another report: the load by its steps only.
    const sent = JSON.stringify({ ...withUsage, details: { ...withUsage.details, load: load === undefined ? undefined : loadStepsOf(load) } });
    if (sent === lastSent) {
      return;
    }
    await deps.fleet.reportSelf(withUsage);
    lastSent = sent;
  };
}

/** The logins as the configuration gives them (api keys K5), and each harness's key state. */
interface LoginsNow {
  readonly configured?: Logins;
  readonly keys: ReadonlyMap<string, KeyStateAt>;
}

function selfReportOf(at: { setup: TrierarchSetup; state: TrierarchState; running: number; trusted: TrustedPlaces; now: Date; logins: LoginsNow }): SelfReport {
  const { setup, state, running, trusted, now, logins } = at;
  const crashed = Object.values(state.entries).filter((entry) => entry.state === 'crashed').length;
  const missing = state.missingPlugins ?? [];
  const stopped = stoppedReasonOf(state, now);
  // A harness without its aeolus-fleet plugin cannot crew a ship (#1212), nor one its adapter does not offer (CC3): it is left out of the details, so no request is placed for it, and the note says why.
  // An adapter's own reason says more than the plugin missing, as Copilot's says how to install its plugin.
  const notOfferedNote =
    missing
      .filter((harness) => state.notOffered?.some((each) => each.harness === harness) !== true)
      .map((harness) => `, ${harness} not offered: ${PLUGIN_MISSING_REASON}`)
      .join('') +
    (state.notOffered ?? []).map(({ harness, reason }) => `, ${harness} not offered: ${reason}`).join('') +
    (stopped === undefined ? '' : `, not offered: ${stopped}`);
  const note = `${String(running)} of ${String(setup.configuration.caps.ships)} running${crashed > 0 ? `, ${String(crashed)} crashed` : ''}${notOfferedNote}`;
  return { state: running > 0 ? 'working' : 'idle', note, details: detailsOf(setup, { state, trusted, stopped, isProbe: isProbing(state.failedStarts, now), logins }) };
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

/** A harness's login as reported (K8): its default and its key's state, picked field by field so nothing else of the state, never a key, is carried (K7). */
function harnessLoginOf(harness: string, logins: LoginsNow): NonNullable<TrierarchReportDetails['harnesses'][number]['login']> {
  const key = logins.keys.get(harness) ?? { state: 'none' };
  return { default: logins.configured?.default?.[harness] ?? 'subscription', key: key.state, ...(key.at !== undefined && { keyStateAt: key.at }) };
}

/** The login of each ship whose session started (K8), with the other one its next start would use (K3); an entry saved before its ship's name was kept goes by its id. */
function shipLoginsOf(state: TrierarchState, logins: LoginsNow): NonNullable<TrierarchReportDetails['logins']> {
  return Object.values(state.entries).flatMap(({ shipId, shipName, harness, login }) => {
    if (login === undefined) {
      return [];
    }
    const next = loginOf({ ...(logins.configured !== undefined && { logins: logins.configured }), harness, shipName: shipName ?? shipId });
    return [{ shipId, login, ...(next !== login && { next }) }];
  });
}

/**
 * The trierarch's report details: what it offers from its configuration and
 * what its harnesses trust, the worktrees it kept and found, its version. A
 * machine that stopped offering itself (#853) offers no harness, and so no
 * place, naming each harness with why; in its probe it has room for one
 * start only.
 */
function detailsOf(setup: TrierarchSetup, at: { state: TrierarchState; trusted: TrustedPlaces; stopped: string | undefined; isProbe: boolean; logins: LoginsNow }): TrierarchReportDetails {
  const { configuration, version } = setup;
  const { state, trusted, stopped, isProbe, logins } = at;
  const missing = state.missingPlugins ?? [];
  const reasonOf = (harness: string): string | undefined => state.notOffered?.find((each) => each.harness === harness)?.reason ?? (missing.includes(harness) ? PLUGIN_MISSING_REASON : stopped);
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
        login: harnessLoginOf(harness, logins),
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
    logins: shipLoginsOf(state, logins),
    ...(setup.machine === undefined || Object.keys(setup.machine).length === 0 ? {} : { machine: setup.machine }),
    // A fact for the console, never a label: placement does not read it (decision 0039).
    runtime: configuration.runtime?.kind ?? 'host',
    version,
  };
}
