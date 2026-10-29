import type { TrierarchConfiguration } from '@aeolus-fleet/common';
import { z } from 'zod';

import type { AdapterFlag, HarnessPort, SessionRuntime } from '../core/ports.js';
import { effectiveFlags } from '../core/effective-flags.js';
import { firstPromptOf, wakePromptOf } from '../core/no-terminal-questions.js';
import { LAUNCH_VARIABLE } from './claude-code.js';
import { partsWithWords, wordsOf, type CommandPart } from './command-line.js';
import { parsedLine } from './hold-protocol.js';
import { createLaunchMarks } from './launch-marker.js';
import { createPluginIdentity, type AeolusPlugin } from './plugin-identity.js';

/**
 * The GitHub Copilot CLI as a harness (docs/architecture.md, "First
 * adapters"; design harnesses/cursor-copilot, CC3, CC4, CC6, CC10), headless:
 * one `copilot -p` per turn in the folder, as Codex runs one `codex exec`, its
 * output as JSON lines, every tool allowed and its question tool off, so a
 * turn asks nothing. Every later turn resumes the session by the id the last
 * turn's result named; a restart too, since `--continue` takes the latest
 * session of the machine, whatever its folder (Copilot CLI 1.0.105). Between
 * turns no Copilot process runs. Copilot signs in with the machine's own
 * login, which the hold's clean environment leaves alone: no GitHub token
 * reaches a session, and no API key (CC6). The identity and the turn marker
 * go through the aeolus-fleet plugin Copilot installed, whose hooks run in
 * `copilot -p` as in a terminal (S3).
 *
 * A failure before the model call (no login, a refused model, a session it
 * cannot resume) fires no hook and writes no JSON line, only its error on
 * stderr and exit status 1: the hold keeps Copilot's stderr lines among the
 * events, wrapped as `aeolus.stderr`, and the launch window reads them as it
 * reads `session.error`, which a failed model call writes.
 */

/** The Copilot CLI builds whose hook roles the aeolus-fleet plugin is proven on (design harnesses/cursor-copilot, S3). */
export const COPILOT_PROVEN_VERSIONS: readonly string[] = ['1.0.105'];

/** The prompt of a restarted session: Copilot has no wake command, so the start context and the crew-a-ship skill say the rest. */
export const WAKE_PROMPT = "Aeolus started this session again: go on crewing this folder's Aeolus ship as the crew-a-ship skill says.";

/** Added to every launch, as mechanism: the turn's events as JSON lines, which the hold keeps (headless H13). */
const JSON_OUTPUT = '--output-format=json';
/** Added to every launch: `copilot -p` runs no tool without it. Running every tool without asking is the mode a session the trierarch runs is in (decision 0016). */
const ALLOW_ALL_TOOLS = '--allow-all-tools';
/** Added to every launch: Copilot's question tool waits for an answer nobody gives; the session asks over the fleet instead (#460). */
const NO_ASK_USER = '--no-ask-user';
const PROMPT = '--prompt=';
const RESUME = '--resume=';

/** The variable Copilot reads its configuration folder from, which the trierarch found its plugin in. */
const COPILOT_HOME_VARIABLE = 'COPILOT_HOME';

/** The line the hold writes for each line Copilot writes on stderr, so the launch window reads what Copilot says before any event. */
export const STDERR_EVENT = 'aeolus.stderr';

export const COPILOT_ADAPTER_FLAGS: readonly AdapterFlag[] = [
  { flag: JSON_OUTPUT, when: 'always' },
  { flag: ALLOW_ALL_TOOLS, when: 'always' },
  { flag: NO_ASK_USER, when: 'always' },
];

/** The flags of Copilot that are risky: beyond every tool, which every launch allows, they open every path and every URL (#326). */
export const COPILOT_RISKY_FLAGS: readonly string[] = ['--allow-all', '--yolo', '--allow-all-paths', '--allow-all-urls'];

/** `copilot`, the configured flags, JSON output, every tool allowed and no question tool, then the session to resume when there is one, and the prompt last as the value of --prompt, so it never reads as a flag. */
export function copilotCommandLine(at: { flags: readonly string[]; prompt: string; sessionId?: string; program?: string }): CommandPart[] {
  return partsWithWords([
    { words: [at.program ?? 'copilot'] },
    { words: at.flags, source: 'configuration' },
    { words: [JSON_OUTPUT], source: 'adapter' },
    { words: [ALLOW_ALL_TOOLS], source: 'adapter' },
    { words: [NO_ASK_USER], source: 'adapter' },
    { words: [...(at.sessionId === undefined ? [] : [`${RESUME}${at.sessionId}`]), `${PROMPT}${at.prompt}`] },
  ]);
}

/** The command of a later turn (CC4): the session's start command, resuming the session by the id given, with the line as its prompt. */
export function copilotTurnCommand(at: { start: readonly string[]; sessionId: string; line: string }): string[] {
  const words = at.start.filter((word) => !word.startsWith(RESUME) && !word.startsWith(PROMPT));
  return [...words, `${RESUME}${at.sessionId}`, `${PROMPT}${at.line}`];
}

/** The line the hold keeps for a line Copilot wrote on stderr. */
export function copilotStderrEvent(line: string): string {
  return JSON.stringify({ type: STDERR_EVENT, line });
}

/** The result that ends each `copilot -p`, the only event naming the session. */
const resultSchema = z.object({ type: z.literal('result'), sessionId: z.string().min(1) });

/** The session id a line of Copilot's output names: its result's; none for any other line. */
export function copilotSessionIdOf(line: string): string | undefined {
  return resultSchema.safeParse(parsedLine(line)).data?.sessionId;
}

const sessionErrorSchema = z.object({ type: z.literal('session.error'), data: z.object({ message: z.string() }) });
const stderrSchema = z.object({ type: z.literal(STDERR_EVENT), line: z.string() });

/** How Copilot CLI 1.0.105 refuses a model this login may not use, before any turn. */
const REFUSED_MODEL = /^Model "([^"]+)" from --model flag is not available\.$/u;
/** How Copilot starts the error it writes on stderr. */
const ERROR_PREFIX = 'Error: ';

/** The last error in Copilot's events: a session error, or the error it wrote on stderr; none without one. */
function lastErrorIn(events: readonly string[]): string | undefined {
  for (const line of [...events].reverse()) {
    const event = parsedLine(line);
    const sessionError = sessionErrorSchema.safeParse(event);
    if (sessionError.success) {
      return sessionError.data.data.message;
    }
    const stderr = stderrSchema.safeParse(event).data?.line;
    if (stderr?.startsWith(ERROR_PREFIX) === true) {
      return stderr.slice(ERROR_PREFIX.length);
    }
  }
  return undefined;
}

/**
 * Why Copilot's start failed, from its last error (headless H13): the model it
 * refused when that is the model it launched with (or any, when it launched
 * with none), or else the error's message. Tested on output captured from
 * Copilot CLI 1.0.105 (test/logs).
 */
export function copilotErrorIn(at: { events: readonly string[]; model?: string }): { kind: 'refused'; model: string } | { kind: 'cause'; cause: string } | undefined {
  const error = lastErrorIn(at.events);
  if (error === undefined) {
    return undefined;
  }
  const refused = REFUSED_MODEL.exec(error)?.[1];
  return refused !== undefined && (at.model === undefined || refused === at.model) ? { kind: 'refused', model: refused } : { kind: 'cause', cause: error };
}

/** The session the last turn in the events named, which a restart resumes; none when no turn named one. */
function lastSessionIn(events: readonly string[]): string | undefined {
  return [...events].reverse().map(copilotSessionIdOf).find((id) => id !== undefined);
}

export function createCopilotHarness(options: {
  configuration: TrierarchConfiguration;
  plugin: AeolusPlugin;
  sessions: Pick<SessionRuntime, 'start' | 'send' | 'interrupt' | 'events'>;
  /** Copilot's version as detection last found it, read each time: a build its plugin is not proven on is not offered (CC3). */
  detectedVersion: () => string | undefined;
  /** Whether sessions run in containers, where Copilot is not proven (CC10). */
  isInContainer: boolean;
  /** The trierarch's COPILOT_HOME, which its sessions get so they use the login and plugin it found; none when it has none. */
  copilotHome?: string;
  /** The program to run; `copilot` unless a test runs another. */
  command?: string;
}): HarnessPort {
  const { configuration, plugin, sessions } = options;
  const marks = createLaunchMarks(plugin);
  const { handOverLine, forceOverLine, ...identity } = createPluginIdentity(plugin);
  const proven = COPILOT_PROVEN_VERSIONS.map((version) => `Copilot CLI ${version}`).join(', ');

  return {
    ...identity,
    launch: async ({ shipId, folder, harness, options: picked, isFirstStart, launchId, login, firstPrompt }) => {
      const settings = configuration.harnesses[harness];
      if (settings === undefined) {
        throw new Error(`The configuration has no harness ${harness}`);
      }
      if (login !== 'subscription') {
        throw new Error("Copilot signs in with this computer's own login (copilot login): it runs on no API key");
      }
      const prompt = isFirstStart && firstPrompt !== undefined ? firstPromptOf(firstPrompt) : wakePromptOf(WAKE_PROMPT);
      // Read before the start, which clears the session's events.
      const sessionId = isFirstStart ? undefined : lastSessionIn(await sessions.events(shipId));
      const command = copilotCommandLine({ flags: effectiveFlags(settings, picked), prompt, ...(sessionId !== undefined && { sessionId }), ...(options.command !== undefined && { program: options.command }) });
      await marks.clear(folder);
      const env = { [LAUNCH_VARIABLE]: launchId, ...(options.copilotHome !== undefined && { [COPILOT_HOME_VARIABLE]: options.copilotHome }) };
      await sessions.start({ shipId, folder, command: wordsOf(command), harness, env });
    },
    handOver: async (session) => {
      const line = await handOverLine(session);
      if (line === undefined) {
        return 'nothing';
      }
      await sessions.send({ shipId: session.shipId, line: wakePromptOf(line) });
      return 'handed';
    },
    forceOver: async ({ shipId, folder, isTurnBusy }) => {
      const line = await forceOverLine({ shipId, folder });
      if (line === undefined) {
        return 'nothing';
      }
      if (isTurnBusy) {
        await sessions.interrupt(shipId);
      }
      await sessions.send({ shipId, line: wakePromptOf(line) });
      return 'handed';
    },
    marksLaunches: () => marks.isMarking(),
    notOfferedReason: () => {
      if (options.isInContainer) {
        return Promise.resolve('Copilot is not proven in a container: the container runtime runs claude-code only');
      }
      const version = options.detectedVersion();
      if (version === undefined) {
        return Promise.resolve(`its Copilot CLI version is not detected yet: the hooks of its aeolus-fleet plugin are proven on ${proven}`);
      }
      return Promise.resolve(COPILOT_PROVEN_VERSIONS.includes(version) ? undefined : `Copilot CLI ${version} is not proven: the hooks of its aeolus-fleet plugin are proven on ${proven}`);
    },
    // The marker says what the session did (#490); what Copilot says before any hook runs, a refused model or login, is read from its output (headless H13).
    launchSeen: async ({ shipId, folder, launchId, model }) => {
      const error = copilotErrorIn({ events: await sessions.events(shipId), ...(model !== undefined && { model }) });
      if (error?.kind === 'refused') {
        return { kind: 'refused', model: error.model };
      }
      if ((await marks.read({ folder, launchId }))?.isActive === true) {
        return { kind: 'active' };
      }
      return { kind: 'none', ...(error !== undefined && { cause: error.cause }) };
    },
  };
}
