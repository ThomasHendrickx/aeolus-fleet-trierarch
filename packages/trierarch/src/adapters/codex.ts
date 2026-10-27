import { readFile } from 'node:fs/promises';

import type { TrierarchConfiguration } from '@aeolus-fleet/common';

import type { AdapterFlag, HarnessPort, SessionRuntime } from '../core/ports.js';
import { LAUNCH_VARIABLE } from './claude-code.js';
import { codexScreenStoppedAt } from './codex-screen.js';
import { codexModelRefusedIn } from './codex-session-log.js';
import type { CodexSetup } from './codex-setup.js';
import { partsWithWords, wordsOf, type CommandPart } from './command-line.js';
import { effectiveFlags } from '../core/effective-flags.js';
import { firstPromptOf, wakePromptOf } from '../core/no-terminal-questions.js';
import { createLaunchMarks } from './launch-marker.js';
import { createPluginIdentity, type AeolusPlugin } from './plugin-identity.js';

/**
 * Codex as a harness (docs/architecture.md, "First adapters"): `codex` in the
 * folder, `codex resume --last` on a restart (the folder's last conversation;
 * one ship per folder), always with `--no-daemon` and without the question
 * tool, and `$aeolus-fleet-wake` sent
 * to wake an idle session, each prompt with the line that no human reads its
 * terminal (#585). The identity and the turn marker go through the
 * aeolus-fleet plugin for Codex, in Codex's own plugin data folder. The plugin's new
 * or changed hooks are trusted before every launch: a plugin update changes
 * them, and Codex would stop the session at its hooks review (#581).
 */

export const WAKE_PROMPT = '$aeolus-fleet-wake';

/**
 * Added to every launch, as mechanism: without it Codex runs the session's
 * work in its shared app-server daemon, which keeps a turn running after the
 * pane is gone, so a release or a crash would stop the pane but not the work.
 */
const NO_DAEMON = '--no-daemon';
/**
 * Added to every launch: Codex's question tool (request_user_input) waits for
 * an answer in the pane, which nobody watches, and would take the keys of a
 * wake. The session asks its questions over the fleet instead (#460).
 */
const NO_QUESTION_TOOL = '--config=tools.experimental_request_user_input.enabled=false';
const END_OF_FLAGS = '--';

/** Why no Codex session starts on the host until Codex runs headless (headless S2). */
const NOT_HEADLESS_YET = 'Codex does not run headless yet, and a session on the host has no terminal: it comes with S2 of the headless design';

export const CODEX_ADAPTER_FLAGS: readonly AdapterFlag[] = [
  { flag: NO_DAEMON, when: 'always' },
  { flag: NO_QUESTION_TOOL, when: 'always' },
];

/** The flags of Codex that are risky: it then runs every command without approval and outside its sandbox (#326). */
export const CODEX_RISKY_FLAGS: readonly string[] = ['--dangerously-bypass-approvals-and-sandbox'];

/** `codex`, or `codex resume --last` on a restart, then the configured flags, --no-daemon once, the question tool off, and the prompt last after `--`, so it never reads as a flag. */
export function codexCommandLine(at: { flags: readonly string[]; prompt: string; isFirstStart: boolean; program?: string }): CommandPart[] {
  const program = at.program ?? 'codex';
  return partsWithWords([
    { words: at.isFirstStart ? [program] : [program, 'resume', '--last'] },
    { words: at.flags.filter((flag) => flag !== NO_DAEMON), source: 'configuration' },
    { words: [NO_DAEMON], source: 'adapter' },
    { words: [NO_QUESTION_TOOL], source: 'adapter' },
    { words: [END_OF_FLAGS, at.prompt] },
  ]);
}

/** The session log at the path given; none before Codex wrote it, or once it is gone. */
async function sessionLog(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

export function createCodexHarness(options: {
  configuration: TrierarchConfiguration;
  plugin: AeolusPlugin;
  sessions: Pick<SessionRuntime, 'start' | 'send' | 'interrupt' | 'events'>;
  /** Codex's own answers, where the aeolus-fleet plugin's hooks are trusted before each launch (#581). */
  setup: Pick<CodexSetup, 'trustAeolusHooks'>;
  /** The program to run; `codex` unless a test runs another. */
  command?: string;
}): HarnessPort {
  const { configuration, plugin, sessions } = options;
  const marks = createLaunchMarks(plugin);
  const { handOverLine, forceOverLine, ...identity } = createPluginIdentity(plugin);

  return {
    ...identity,
    // Codex still runs in a terminal, and the host gives a session none: no Codex session starts until S2 of the headless design.
    startProblem: async () => (await identity.startProblem()) ?? NOT_HEADLESS_YET,
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
    // The marker says what the session did (#490); Codex has no hook for a failed turn, so a refusal is read from the session log its session start named.
    launchSeen: async ({ shipId, folder, launchId, model }) => {
      const marker = await marks.read({ folder, launchId });
      const log = marker?.transcript === undefined ? undefined : await sessionLog(marker.transcript);
      const refused = log === undefined ? undefined : codexModelRefusedIn({ log, ...(model !== undefined && { model }) });
      if (refused !== undefined) {
        return { kind: 'refused', model: refused };
      }
      if (marker?.isActive === true) {
        return { kind: 'active' };
      }
      const stoppedAt = marker?.isStarted === true ? undefined : codexScreenStoppedAt((await sessions.events(shipId)).join('\n'));
      return { kind: 'none', ...(stoppedAt !== undefined && { screen: stoppedAt }) };
    },
  };
}
