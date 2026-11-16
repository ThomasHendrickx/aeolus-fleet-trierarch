import type { TrierarchConfiguration } from '@aeolus-fleet/common';
import { z } from 'zod';

import type { HarnessPort, SessionRuntime, Turn } from '../core/ports.js';
import { effectiveFlags } from '../core/effective-flags.js';
import { firstPromptOf, wakePromptOf } from '../core/no-terminal-questions.js';
import { LAUNCH_VARIABLE } from './claude-code.js';
import { wordsOf } from './command-line.js';
import { cursorActivityIn, cursorCommandLine, cursorErrorIn, cursorSessionIdOf } from './cursor-session.js';
import { parsedLine } from './hold-protocol.js';
import { createLaunchMarks } from './launch-marker.js';
import { createPluginIdentity, type AeolusPlugin } from './plugin-identity.js';
import { sessionActivityOf } from './session-activity.js';

/** Cursor's approved host protocol: one CLI process per turn, resume by chat id, and sessionEnd hooks confirming tool-free turns (CC3/CC4). */
export const CURSOR_PROVEN_VERSIONS: readonly string[] = ['2026.11.13-eacade1'];
export const CURSOR_RISKY_FLAGS: readonly string[] = ['--force', '--yolo', '--sandbox=disabled'];
export const CURSOR_WAKE_PROMPT = "Aeolus started this session again: go on crewing this folder's Aeolus ship as the crew-a-ship skill says.";
const processTurn = z.object({ type: z.literal('aeolus.turn'), state: z.enum(['busy', 'idle']) });

export function createCursorHarness(options: {
  configuration: TrierarchConfiguration;
  plugin: AeolusPlugin;
  sessions: Pick<SessionRuntime, 'start' | 'send' | 'interrupt' | 'events' | 'lastEventAt'>;
  detectedVersion: () => string | undefined;
  isInContainer: boolean;
}): HarnessPort {
  const { configuration, plugin, sessions } = options;
  const marks = createLaunchMarks(plugin);
  const { handOverLine, forceOverLine, ...identity } = createPluginIdentity(plugin);
  return {
    ...identity,
    launch: async ({ shipId, folder, harness, options: picked, isFirstStart, launchId, login, firstPrompt }) => {
      const settings = configuration.harnesses[harness];
      if (settings === undefined) throw new Error(`The configuration has no harness ${harness}`);
      if (login !== 'subscription') throw new Error("Cursor signs in with this computer's own login (agent login): it runs on no API key");
      const sessionId = isFirstStart ? undefined : [...await sessions.events(shipId)].reverse().map(cursorSessionIdOf).find((id) => id !== undefined);
      const prompt = isFirstStart && firstPrompt !== undefined ? firstPromptOf(firstPrompt) : wakePromptOf(CURSOR_WAKE_PROMPT);
      const command = cursorCommandLine({ flags: [...effectiveFlags(settings, picked), '--plugin-dir', await plugin.root()], prompt, ...(sessionId !== undefined && { sessionId }) });
      await marks.clear(folder);
      await sessions.start({ shipId, folder, harness, command: wordsOf(command), env: { [LAUNCH_VARIABLE]: launchId, AEOLUS_DATA: plugin.data, AEOLUS_CREWS: plugin.crews } });
    },
    handOver: async (session) => {
      const line = await handOverLine(session);
      if (line === undefined) return 'nothing';
      await sessions.send({ shipId: session.shipId, line: wakePromptOf(line) });
      return 'handed';
    },
    forceOver: async ({ shipId, folder, isTurnBusy }) => {
      const line = await forceOverLine({ shipId, folder });
      if (line === undefined) return 'nothing';
      if (isTurnBusy) await sessions.interrupt(shipId);
      await sessions.send({ shipId, line: wakePromptOf(line) });
      return 'handed';
    },
    turnOf: async ({ shipId }): Promise<Turn> => {
      for (const line of [...await sessions.events(shipId)].reverse()) {
        const turn = processTurn.safeParse(parsedLine(line)).data;
        if (turn !== undefined) return turn.state;
      }
      return 'unknown';
    },
    marksLaunches: () => marks.isMarking(),
    notOfferedReason: async () => {
      if ((await plugin.root().catch(() => undefined)) === undefined) return 'its aeolus-fleet plugin is not installed for Cursor: install it in ~/.cursor/plugins/local/aeolus-fleet or set AEOLUS_CURSOR_PLUGIN_ROOT';
      if (options.isInContainer) return 'Cursor is not proven in a container: the container runtime runs claude-code only';
      const version = options.detectedVersion();
      if (version === undefined) return `its Cursor CLI version is not detected yet: its hook roles are proven on ${CURSOR_PROVEN_VERSIONS.join(', ')}`;
      return CURSOR_PROVEN_VERSIONS.includes(version) ? undefined : `Cursor CLI ${version} is not proven: sessionStart, preToolUse, postToolUse and sessionEnd roles are proven on ${CURSOR_PROVEN_VERSIONS.join(', ')}`;
    },
    activityOf: async ({ shipId }) => sessionActivityOf({ sessions, shipId, read: cursorActivityIn }),
    failureReason: async ({ shipId }) => {
      const error = cursorErrorIn({ events: await sessions.events(shipId) });
      return error?.kind === 'cause' ? error.cause : error?.model;
    },
    launchSeen: async ({ shipId, folder, launchId, model }) => {
      const error = cursorErrorIn({ events: await sessions.events(shipId), ...(model !== undefined && { model }) });
      if (error?.kind === 'refused') return { kind: 'refused', model: error.model };
      if ((await marks.read({ folder, launchId }))?.isActive === true) return { kind: 'active' };
      return { kind: 'none', ...(error !== undefined && { cause: error.cause }) };
    },
  };
}
