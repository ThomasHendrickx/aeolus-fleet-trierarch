import { mkdir, stat, writeFile } from 'node:fs/promises';
import { idSchema, type ShipId, type TrierarchConfiguration } from '@aeolus-fleet/common';

import type { ClaudeCodeSetup } from '../adapters/claude-code-setup.js';
import type { CodexSetup } from '../adapters/codex-setup.js';
import { configurationJsonSchema, initialConfiguration, loadConfiguration, readCrewFile, TrierarchFileError, writeCrewFile } from '../adapters/files.js';
import type { TrierarchPaths } from '../adapters/paths.js';
import type { RestFleet } from '../adapters/rest-fleet.js';
import type { Service } from '../adapters/service.js';
import type { DetectHarnesses } from '../core/detect-harnesses.js';
import { describeDetected } from './detect.js';
import { absolutePath, nameRefusal, placeRefusal } from './places.js';
import type { Prompter } from './prompter.js';

/**
 * `aeolus-trierarch init`: the whole setup of a machine, asking for what is
 * missing. It registers the trierarch's own ship (commissioned by the
 * trierarch plugin, with crew:run) and keeps its crew token, never the secret; writes the
 * configuration from the operator's answers; answers Claude Code's one-time
 * questions ahead, so a session nobody watches never waits on one; and offers
 * to install and start the service. On a machine set up already it says so,
 * never registers again, and offers to change the configuration.
 */

export interface InitFlags {
  readonly fleetUrl?: string;
  readonly shipId?: string;
  readonly secret?: string;
  /** Asks nothing: every default is taken, and the fleet URL, ship id and secret must be flags. */
  readonly isYes: boolean;
}

/** What init did, for the operator and for `--json`. */
export interface InitReport {
  readonly isSetUpAlready: boolean;
  readonly fleetUrl: string;
  readonly shipId?: ShipId;
  readonly configuration: 'written' | 'changed' | 'kept';
  /** The places Claude Code now trusts: the worktree root, then each configured repository and folder. */
  readonly trusted: readonly string[];
  readonly isSkipPermissionsAccepted: boolean;
  /** The repositories and folders Codex now trusts, when the configuration offers Codex. */
  readonly codexTrusted: readonly string[];
  /** The aeolus plugin's hooks Codex trusts since this run, by key. */
  readonly codexHooksTrusted: readonly string[];
  readonly service: 'installed' | 'restarted' | 'unchanged' | 'notInstalled';
  readonly said: readonly string[];
}

const CLAUDE_CODE = 'claude-code';
const SKIP_PERMISSIONS = '--dangerously-skip-permissions';
const REMOTE_CONTROL = '--remote-control';
const CODEX = 'codex';
const BYPASS_APPROVALS = '--dangerously-bypass-approvals-and-sandbox';

type Accepted<T> = { readonly value: T } | { readonly why: string };

/** Takes every default, and refuses a question that has none: what `--yes` asks. */
function defaultsOnly(prompter: Prompter): Prompter {
  const refuse = (question: string): Promise<never> => Promise.reject(new TrierarchFileError(`init --yes has no answer to: ${question}`));
  return {
    text: (question, options = {}) => (options.default === undefined ? refuse(question) : Promise.resolve(options.default)),
    secret: refuse,
    confirm: (_question, { isDefault }) => Promise.resolve(isDefault),
    say: (message) => {
      prompter.say(message);
    },
    // --yes asks nothing, so no step has a question to show its title before.
    step: () => undefined,
  };
}

/** Asks until the answer is one `accept` takes, saying why each other one is not. */
async function askUntil<T>(at: { prompter: Prompter; ask: () => Promise<string>; accept: (answer: string) => Accepted<T> | Promise<Accepted<T>> }): Promise<T> {
  for (;;) {
    const accepted = await at.accept((await at.ask()).trim());
    if ('value' in accepted) {
      return accepted.value;
    }
    at.prompter.say(accepted.why);
  }
}

function asShipId(answer: string): Accepted<ShipId> {
  const parsed = idSchema('ship').safeParse(answer);
  return parsed.success ? { value: parsed.data } : { why: `${answer} is no ship id: it starts with shp_.` };
}

function asFleetUrl(answer: string): Accepted<string> {
  const url = URL.parse(answer);
  return url !== null && (url.protocol === 'https:' || url.protocol === 'http:') ? { value: answer.replace(/\/$/, '') } : { why: `${answer} is no http or https URL.` };
}

function asCap(answer: string): Accepted<number> {
  return /^[1-9]\d*$/.test(answer) ? { value: Number(answer) } : { why: 'A cap is a whole number of 1 or more.' };
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined)) !== undefined;
}

/** The fleet URL, ship id and secret, from the flags or asked; with --yes all three must be flags. */
async function askCrew(flags: InitFlags, prompter: Prompter): Promise<{ fleetUrl: string; shipId: ShipId; secret: string }> {
  if (flags.isYes) {
    const missing = [
      ...(flags.fleetUrl === undefined ? ['--fleet-url'] : []),
      ...(flags.shipId === undefined ? ['--ship-id'] : []),
      ...(flags.secret === undefined ? ['--secret'] : []),
    ];
    if (missing.length > 0) {
      const named = missing.length === 1 ? `${missing.join('')} is` : `${missing.slice(0, -1).join(', ')} and ${missing.at(-1) ?? ''} are`;
      throw new TrierarchFileError(`init --yes needs --fleet-url, --ship-id and --secret: ${named} missing`);
    }
  }
  const fromFlag = <T>(value: string | undefined, accept: (answer: string) => Accepted<T>): T | undefined => {
    if (value === undefined) {
      return undefined;
    }
    const accepted = accept(value.trim());
    if ('why' in accepted) {
      throw new TrierarchFileError(accepted.why);
    }
    return accepted.value;
  };
  const fleetUrl = fromFlag(flags.fleetUrl, asFleetUrl) ?? (await askUntil({ prompter, ask: () => prompter.text('Fleet URL (https://...)?'), accept: asFleetUrl }));
  const shipId =
    fromFlag(flags.shipId, asShipId) ??
    (await askUntil({ prompter, ask: () => prompter.text("The trierarch's ship id (shp_..., from its starting prompt in the console)?"), accept: asShipId }));
  const secret = flags.secret ?? (await prompter.secret('Its secret (aeolus_sk_v1_..., not shown as you type)?'));
  return { fleetUrl, shipId, secret };
}

/** How init asks for one kind of named place: repositories or folders. */
interface PlaceQuestions {
  /** Its word in "Keep the <kind> <name>?". */
  readonly kind: 'repository' | 'folder';
  readonly add: string;
  where(name: string): string;
}

/** Named places: each one held kept or dropped as answered, then new ones, name and path, until the operator is done. */
async function askPlaces(at: { held: Readonly<Record<string, { path: string }>>; prompter: Prompter; homeDirectory: string; questions: PlaceQuestions }): Promise<Record<string, { path: string }>> {
  const { held, prompter, homeDirectory, questions } = at;
  const places: Record<string, { path: string }> = {};
  for (const [name, place] of Object.entries(held)) {
    if (await prompter.confirm(`Keep the ${questions.kind} ${name} (${place.path})?`, { isDefault: true })) {
      places[name] = place;
    }
  }
  for (;;) {
    const name = await askUntil<string>({
      prompter,
      ask: () => prompter.text(questions.add, { default: '' }),
      accept: (answer) => {
        const why = answer === '' ? undefined : nameRefusal(answer);
        return why === undefined ? { value: answer } : { why };
      },
    });
    if (name === '') {
      return places;
    }
    const path = await askUntil<string>({
      prompter,
      ask: () => prompter.text(questions.where(name)),
      accept: async (answer) => {
        const absolute = absolutePath(answer, homeDirectory);
        const why = await placeRefusal(questions.kind, absolute);
        return why === undefined ? { value: absolute } : { why };
      },
    });
    places[name] = { path };
  }
}

const REPOSITORY_QUESTIONS: PlaceQuestions = {
  kind: 'repository',
  add: 'Add a repository it may make worktrees of: its name, or nothing when done?',
  where: (name) => `Where is ${name} checked out?`,
};

const FOLDER_QUESTIONS: PlaceQuestions = {
  kind: 'folder',
  add: 'Add a folder it may crew a ship in as it is: its name, or nothing when done?',
  where: (name) => `Where is ${name}?`,
};

/**
 * Codex's harness from the operator's answers, asked only where Codex is
 * installed or offered already: whether to offer it, and its flags. Undefined
 * when it is not offered.
 */
async function askCodex(at: { base: TrierarchConfiguration; prompter: Prompter; isCodexInstalled: boolean }): Promise<TrierarchConfiguration['harnesses'][string] | undefined> {
  const { base, prompter } = at;
  const harness = base.harnesses[CODEX];
  if (!(at.isCodexInstalled || harness !== undefined) || !(await prompter.confirm('Offer Codex as a harness too?', { isDefault: true }))) {
    return undefined;
  }
  const flags = harness?.flags ?? [];
  const isBypassing = await prompter.confirm(`Launch Codex with ${BYPASS_APPROVALS}? Its sessions then run every command without asking, and outside the sandbox.`, {
    isDefault: flags.includes(BYPASS_APPROVALS),
  });
  return {
    options: harness?.options ?? {},
    flags: [...flags.filter((flag) => flag !== BYPASS_APPROVALS), ...(isBypassing ? [BYPASS_APPROVALS] : [])],
  };
}

/** The configuration from the operator's answers, starting from what it holds: Claude Code's and Codex's flags, the repositories, the folders and the caps. Everything else is kept. */
async function askConfiguration(at: { base: TrierarchConfiguration; prompter: Prompter; homeDirectory: string; isCodexInstalled: boolean }): Promise<TrierarchConfiguration> {
  const { base, prompter } = at;
  const harness = base.harnesses[CLAUDE_CODE] ?? { flags: [], options: {} };
  prompter.step('Claude Code');
  const isSkipping = await prompter.confirm(`Launch Claude Code with ${SKIP_PERMISSIONS}? Its sessions then run every tool without asking.`, {
    isDefault: harness.flags.includes(SKIP_PERMISSIONS),
  });
  const isRemote = await prompter.confirm(`Launch Claude Code with ${REMOTE_CONTROL}, so you can follow each session from claude.ai?`, {
    isDefault: harness.flags.includes(REMOTE_CONTROL),
  });
  const flags = [
    ...harness.flags.filter((flag) => flag !== SKIP_PERMISSIONS && flag !== REMOTE_CONTROL),
    ...(isSkipping ? [SKIP_PERMISSIONS] : []),
    ...(isRemote ? [REMOTE_CONTROL] : []),
  ];
  prompter.step('Codex');
  const codex = await askCodex(at);
  prompter.step('Workspaces');
  const repositories = await askPlaces({ held: base.repositories, prompter, homeDirectory: at.homeDirectory, questions: REPOSITORY_QUESTIONS });
  const folders = await askPlaces({ held: base.folders, prompter, homeDirectory: at.homeDirectory, questions: FOLDER_QUESTIONS });
  prompter.step('Caps');
  const ships = await askUntil({ prompter, ask: () => prompter.text('How many ships may it keep on its list?', { default: String(base.caps.ships) }), accept: asCap });
  const running = await askUntil({ prompter, ask: () => prompter.text('How many sessions may run at once?', { default: String(base.caps.running) }), accept: asCap });
  const others = Object.fromEntries(Object.entries(base.harnesses).filter(([name]) => name !== CODEX));
  return {
    ...base,
    caps: { ships, running },
    repositories,
    folders,
    harnesses: { ...others, [CLAUDE_CODE]: { ...harness, flags }, ...(codex !== undefined && { [CODEX]: codex }) },
  };
}

export async function initTrierarch(input: {
  homeDirectory: string;
  paths: TrierarchPaths;
  flags: InitFlags;
  prompter: Prompter;
  fleetAt: (fleetUrl: string) => Pick<RestFleet, 'registerSelf'>;
  claudeCode: ClaudeCodeSetup;
  codex: CodexSetup;
  /** Whether `codex` runs on this machine: only then, or when Codex is configured, does init ask about it. */
  isCodexInstalled: boolean;
  /** Detects the configured harnesses' options (#365), once per harness version. */
  detect: DetectHarnesses;
  service: Pick<Service, 'install' | 'restart' | 'status'>;
}): Promise<InitReport> {
  const { homeDirectory, paths, flags, claudeCode, service, isCodexInstalled } = input;
  const prompter = flags.isYes ? defaultsOnly(input.prompter) : input.prompter;
  const said: string[] = [];

  // The ship: registered once per machine, never again.
  const crew = await readCrewFile(paths.crewToken).catch(() => undefined);
  let fleetUrl: string;
  let shipId: ShipId | undefined;
  if (crew === undefined) {
    prompter.step('The fleet');
    const asked = await askCrew(flags, prompter);
    const { crewToken } = await input.fleetAt(asked.fleetUrl).registerSelf({ shipId: asked.shipId, secret: asked.secret });
    await writeCrewFile(paths.crewToken, { fleetUrl: asked.fleetUrl, shipId: asked.shipId, crewToken });
    ({ fleetUrl, shipId } = asked);
    said.push(`Registered ${shipId} at ${fleetUrl}: its crew token is kept in ${paths.crewToken}, readable by you only. The secret is written nowhere.`);
  } else {
    ({ fleetUrl, shipId } = crew);
    const ship = `the trierarch crews ${shipId ?? 'its ship'} at ${fleetUrl}`;
    if (flags.shipId !== undefined || flags.secret !== undefined) {
      throw new TrierarchFileError(`This machine is set up already: ${ship}. init never registers again: to register another ship, remove ${paths.crewToken} first`);
    }
    said.push(`This machine is set up already: ${ship}.`);
  }
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await writeFile(paths.configSchema, `${JSON.stringify(configurationJsonSchema(), null, 2)}\n`);

  // The configuration: written from the answers, or changed only when the operator says so.
  let configuration: TrierarchConfiguration;
  let configured: InitReport['configuration'] = 'kept';
  if (!(await exists(paths.config))) {
    configuration = { $schema: './config.schema.json', ...(await askConfiguration({ base: initialConfiguration(), prompter, homeDirectory, isCodexInstalled })) };
    configured = 'written';
  } else {
    configuration = await loadConfiguration(paths.config);
    if (await prompter.confirm('Change the configuration?', { isDefault: false })) {
      configuration = await askConfiguration({ base: configuration, prompter, homeDirectory, isCodexInstalled });
      configured = 'changed';
    }
  }
  if (configured !== 'kept') {
    await writeFile(paths.config, `${JSON.stringify(configuration, null, 2)}\n`);
    said.push(`Configuration ${configured} at ${paths.config}.`);
  }
  if (Object.keys(configuration.repositories).length === 0 && Object.keys(configuration.folders).length === 0) {
    said.push('It has no repository or folder yet, so it can crew no request: run aeolus-trierarch init again to add one.');
  }

  // Claude Code's one-time questions, answered ahead.
  const root = configuration.worktreeRoot ?? paths.worktrees;
  await mkdir(root, { recursive: true });
  const repositories = Object.values(configuration.repositories).map((repository) => repository.path);
  const folders = Object.values(configuration.folders).map((folder) => folder.path);
  // Adding a place through init is what trusts it (#381); every run, so a place added since is trusted too.
  for (const place of [root, ...repositories, ...folders]) {
    await claudeCode.trust(place);
  }
  said.push(`Claude Code trusts ${root}, so a session in any worktree starts with no trust question.`);
  if (repositories.length > 0) {
    said.push(`Claude Code trusts each configured repository too, as it asks about a worktree's repository: ${repositories.join(', ')}.`);
  }
  if (folders.length > 0) {
    said.push(`Claude Code trusts each configured folder too: ${folders.join(', ')}.`);
  }
  let isSkipPermissionsAccepted = await claudeCode.isSkipPermissionsAccepted();
  if (configuration.harnesses[CLAUDE_CODE]?.flags.includes(SKIP_PERMISSIONS) === true && !isSkipPermissionsAccepted) {
    if (await prompter.confirm('Claude Code asks once per user to accept bypass permissions mode. Accept it now (skipDangerousModePermissionPrompt in ~/.claude/settings.json)?', { isDefault: true })) {
      await claudeCode.acceptSkipPermissions();
      isSkipPermissionsAccepted = true;
      said.push('Claude Code accepts bypass permissions mode for you.');
    } else {
      said.push(`Claude Code still asks to accept bypass permissions mode, and a session started with ${SKIP_PERMISSIONS} waits on that question until you answer it.`);
    }
  }

  const codex = await setUpCodex({ configuration, codex: input.codex, root });
  said.push(...codex.said);

  // What each harness offers, detected on this machine and kept apart from the configuration (#365).
  const harnesses = Object.keys(configuration.harnesses);
  said.push(...describeDetected({ harnesses, detected: await input.detect({ harnesses, by: 'start' }) }).split('\n'));

  // The service: offered when it is not installed, restarted when it should read a new configuration.
  prompter.step('The service');
  let serviced: InitReport['service'] = 'unchanged';
  const status = await service.status();
  if (!status.isInstalled) {
    if (await prompter.confirm('Install the service and start the trierarch now? It then starts again at every login.', { isDefault: true })) {
      await service.install();
      serviced = 'installed';
      said.push(`The trierarch runs, and starts again at every login (${status.file}). See it with aeolus-trierarch status.`);
    } else {
      serviced = 'notInstalled';
      said.push('Install and start it later with aeolus-trierarch install.');
    }
  } else if (configured !== 'kept' && (await prompter.confirm('Restart the trierarch so it reads the new configuration?', { isDefault: true }))) {
    await service.restart();
    serviced = 'restarted';
    said.push('The trierarch restarted with the new configuration.');
  }

  return {
    isSetUpAlready: crew !== undefined,
    fleetUrl,
    ...(shipId !== undefined && { shipId }),
    configuration: configured,
    trusted: [root, ...repositories, ...folders],
    isSkipPermissionsAccepted,
    codexTrusted: codex.trusted,
    codexHooksTrusted: codex.hooksTrusted,
    service: serviced,
    said,
  };
}

/**
 * Codex's one-time questions, answered ahead on every run where the
 * configuration offers Codex: each repository and folder trusted (a folder
 * added since among them), and the aeolus plugin's hooks, which a plugin
 * update changes. When Codex cannot be set up, init says so and goes on.
 */
async function setUpCodex(at: { configuration: TrierarchConfiguration; codex: CodexSetup; root: string }): Promise<{ trusted: readonly string[]; hooksTrusted: readonly string[]; said: readonly string[] }> {
  const { configuration, codex, root } = at;
  if (configuration.harnesses[CODEX] === undefined) {
    return { trusted: [], hooksTrusted: [], said: [] };
  }
  const folders = [...Object.values(configuration.repositories), ...Object.values(configuration.folders)].map((place) => place.path);
  try {
    await codex.trust(folders);
    const hooksTrusted = await codex.trustAeolusHooks(root);
    return {
      trusted: folders,
      hooksTrusted,
      said: [
        ...(folders.length > 0 ? [`Codex trusts each configured repository and folder, so a session there, or in a worktree of one, starts with no trust question: ${folders.join(', ')}.`] : []),
        hooksTrusted.length > 0 ? `Codex trusts the aeolus plugin's ${String(hooksTrusted.length)} new or changed hooks.` : "Codex trusts the aeolus plugin's hooks already.",
      ],
    };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { trusted: [], hooksTrusted: [], said: [`Codex is not set up: ${why}. A Codex session waits on its trust questions until you run aeolus-trierarch init again.`] };
  }
}

