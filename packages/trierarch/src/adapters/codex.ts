import type { TrierarchConfiguration } from '@aeolus-fleet/common';
import { z } from 'zod';

import type { AdapterFlag, HarnessPort, SessionRuntime } from '../core/ports.js';
import { LAUNCH_VARIABLE } from './claude-code.js';
import type { CodexSetup } from './codex-setup.js';
import { partsWithWords, wordsOf, type CommandPart } from './command-line.js';
import { effectiveFlags } from '../core/effective-flags.js';
import { firstPromptOf, wakePromptOf } from '../core/no-terminal-questions.js';
import { parsedLine } from './hold-protocol.js';
import { createLaunchMarks } from './launch-marker.js';
import { createPluginIdentity, type AeolusPlugin } from './plugin-identity.js';

/**
 * Codex as a harness (docs/architecture.md, "First adapters"), headless
 * (headless H11): one `codex exec --json` per turn in the folder, the first
 * with the first prompt, a restart `codex exec resume --last` (the folder's
 * last conversation; one ship per folder), and every later turn `codex exec
 * resume <thread id>`, which the hold starts for each line it is sent; between
 * turns no Codex process runs. Always without the question tool, and
 * `$aeolus-wake` sent to wake an idle session, each prompt with the line that
 * no human reads its terminal (#585). The identity and the turn marker go
 * through the aeolus plugin for Codex, in Codex's own plugin data folder,
 * whose hooks run in `codex exec` as in a terminal. The plugin's new or
 * changed hooks are trusted before every launch: a plugin update changes them,
 * and Codex runs none it does not trust (#581).
 */

export const WAKE_PROMPT = '$aeolus-wake';

/** Added to every launch, as mechanism: the turn's events as JSON lines, which the hold keeps (headless H13, H14). */
const JSON_EVENTS = '--json';
/**
 * Left out of the configured flags: `codex exec` does not take it, and runs
 * its turn in its own process, so a stop stops its work. Configurations
 * written for Codex in a terminal may still carry it.
 */
const NO_DAEMON = '--no-daemon';
/**
 * Added to every launch: Codex's question tool (request_user_input) waits for
 * an answer nobody gives, and would hold the turn. The session asks its
 * questions over the fleet instead (#460).
 */
const NO_QUESTION_TOOL = '--config=tools.experimental_request_user_input.enabled=false';
const END_OF_FLAGS = '--';
const EXEC = 'exec';
const RESUME = 'resume';
const LAST = '--last';

export const CODEX_ADAPTER_FLAGS: readonly AdapterFlag[] = [
  { flag: JSON_EVENTS, when: 'always' },
  { flag: NO_QUESTION_TOOL, when: 'always' },
];

/** The flags of Codex that are risky: it then runs every command without approval and outside its sandbox (#326). */
export const CODEX_RISKY_FLAGS: readonly string[] = ['--dangerously-bypass-approvals-and-sandbox'];

/** `codex exec`, or `codex exec resume --last` on a restart, then the configured flags, --json, the question tool off, and the prompt last after `--`, so it never reads as a flag. */
export function codexCommandLine(at: { flags: readonly string[]; prompt: string; isFirstStart: boolean; program?: string }): CommandPart[] {
  const program = at.program ?? 'codex';
  return partsWithWords([
    { words: at.isFirstStart ? [program, EXEC] : [program, EXEC, RESUME, LAST] },
    { words: at.flags.filter((flag) => flag !== NO_DAEMON), source: 'configuration' },
    { words: [JSON_EVENTS], source: 'adapter' },
    { words: [NO_QUESTION_TOOL], source: 'adapter' },
    { words: [END_OF_FLAGS, at.prompt] },
  ]);
}

/**
 * The command of a later turn (headless H11): the session's start command,
 * resuming its thread by id instead of the folder's last conversation, with
 * the line as its prompt after `--`.
 */
export function codexTurnCommand(at: { start: readonly string[]; threadId: string; line: string }): string[] {
  const end = at.start.lastIndexOf(END_OF_FLAGS);
  const words = end === -1 ? at.start : at.start.slice(0, end);
  // The program is every word before exec: a test runs Codex's stand-in as Node and its script.
  const exec = words.indexOf(EXEC);
  const rest = words.slice(exec + 1);
  const flags = rest[0] === RESUME && rest[1] === LAST ? rest.slice(2) : rest;
  return [...words.slice(0, exec), EXEC, RESUME, at.threadId, ...flags, END_OF_FLAGS, at.line];
}

/** The event of `codex exec --json` that names the session's thread, which a later turn resumes (H11). */
export const codexThreadStartedSchema = z.object({ type: z.literal('thread.started'), thread_id: z.string().min(1) });

/** Codex's error events in `codex exec --json`: a failed turn, or an error the turn met. */
const errorEventSchema = z.union([z.object({ type: z.literal('turn.failed'), error: z.object({ message: z.string() }) }), z.object({ type: z.literal('error'), message: z.string() })]);

/** The API error an error event carries as JSON text in its message, as Codex passes a refusal on. */
const apiErrorSchema = z.object({ error: z.object({ message: z.string(), code: z.string().optional() }) });

const NOT_SUPPORTED = /^The '([^']+)' model is not supported/u;

/** The harness's last error event in its events, as its message says it: an API error by its own message; none without one. */
function lastErrorIn(events: readonly string[]): { message: string; code?: string } | undefined {
  for (const line of [...events].reverse()) {
    const event = errorEventSchema.safeParse(parsedLine(line));
    if (event.success) {
      const message = event.data.type === 'turn.failed' ? event.data.error.message : event.data.message;
      const api = apiErrorSchema.safeParse(parsedLine(message));
      return api.success ? { message: api.data.error.message, ...(api.data.error.code !== undefined && { code: api.data.error.code }) } : { message };
    }
  }
  return undefined;
}

/**
 * Why Codex's start failed, from its last error event (headless H13): the
 * model it refused when that is the model it launched with (or any, when it
 * launched with none, so Codex's own default), or else the error's message.
 * Codex has no hook for a failed turn (#490). Its event shapes are tested on
 * events captured from `codex exec --json` (test/logs).
 */
export function codexErrorIn(at: { events: readonly string[]; model?: string }): { kind: 'refused'; model: string } | { kind: 'cause'; cause: string } | undefined {
  const error = lastErrorIn(at.events);
  if (error === undefined) {
    return undefined;
  }
  const refused = error.code === 'model_not_found' ? NOT_SUPPORTED.exec(error.message)?.[1] : undefined;
  return refused !== undefined && (at.model === undefined || refused === at.model) ? { kind: 'refused', model: refused } : { kind: 'cause', cause: error.message };
}

export function createCodexHarness(options: {
  configuration: TrierarchConfiguration;
  plugin: AeolusPlugin;
  sessions: Pick<SessionRuntime, 'start' | 'send' | 'interrupt' | 'events'>;
  /** Codex's own answers, where the aeolus plugin's hooks are trusted before each launch (#581). */
  setup: Pick<CodexSetup, 'trustAeolusHooks'>;
  /** The program to run; `codex` unless a test runs another. */
  command?: string;
}): HarnessPort {
  const { configuration, plugin, sessions } = options;
  const marks = createLaunchMarks(plugin);
  const { handOverLine, forceOverLine, ...identity } = createPluginIdentity(plugin);

  return {
    ...identity,
    launch: async ({ shipId, folder, checkouts, harness, options: picked, isFirstStart, launchId, firstPrompt }) => {
      const settings = configuration.harnesses[harness];
      if (settings === undefined) {
        throw new Error(`The configuration has no harness ${harness}`);
      }
      const prompt = isFirstStart && firstPrompt !== undefined ? firstPromptOf(firstPrompt) : wakePromptOf(WAKE_PROMPT);
      const command = codexCommandLine({ flags: effectiveFlags(settings, picked), prompt, isFirstStart, ...(options.command !== undefined && { program: options.command }) });
      await options.setup.trustAeolusHooks(folder);
      await marks.clear(folder);
      // Codex reads outside its folder as it is: its read-only checkouts need no flag (#1182).
      await sessions.start({ shipId, folder, command: wordsOf(command), harness, env: { [LAUNCH_VARIABLE]: launchId }, ...(checkouts.length > 0 && { readOnly: checkouts.map((checkout) => checkout.path) }) });
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
    // The marker says what the session did (#490); Codex has no hook for a failed turn, so a refusal, or why a start shows none, is read from its last error event (headless H13).
    launchSeen: async ({ shipId, folder, launchId, model }) => {
      const error = codexErrorIn({ events: await sessions.events(shipId), ...(model !== undefined && { model }) });
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
