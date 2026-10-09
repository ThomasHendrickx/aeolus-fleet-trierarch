import { setTimeout as wait } from 'node:timers/promises';

import { idSchema, type ShipId } from '@aeolus-fleet/common';

import type { ObservedSession, ProcessPort } from '../core/ports.js';
import { runCommand } from './run-command.js';

/**
 * Sessions in tmux (docs/architecture.md, "First adapters"): one tmux session
 * per ship, named after its ship id, kept on exit so an exit is seen. The
 * trierarch uses its own tmux server (`tmux -L aeolus-trierarch`), so it never
 * touches the operator's own sessions.
 */
export interface Tmux extends ProcessPort {
  /** Starts the command in the folder, in a new session for the ship; an exited one is replaced. */
  start(session: { shipId: ShipId; folder: string; command: readonly string[] }): Promise<void>;
  /** Types the text into the ship's session and presses Enter, after `settleMs` when given. */
  type(at: { shipId: ShipId; text: string; settleMs?: number }): Promise<void>;
  /** What the ship's session shows: its last lines, wrapped ones joined; empty with no session. */
  screen(shipId: ShipId): Promise<string>;
}

const PREFIX = 'trierarch-';
export const TMUX_SERVER = 'aeolus-trierarch';
/** How many lines back a screen is read: the launch window's first prompt fits well within. */
const SCREEN_LINES = 200;

function sessionName(shipId: ShipId): string {
  return `${PREFIX}${shipId}`;
}

export function createTmux(options: { server?: string } = {}): Tmux {
  const server = options.server ?? TMUX_SERVER;
  const tmux = async (args: readonly string[]): Promise<{ status: number; stdout: string; stderr: string }> => runCommand('tmux', { args: ['-L', server, ...args] });
  const must = async (args: readonly string[]): Promise<string> => {
    const result = await tmux(args);
    if (result.status !== 0) {
      throw new Error(`tmux ${args.join(' ')} failed: ${result.stderr.trim()}`);
    }
    return result.stdout;
  };

  return {
    list: async () => {
      const result = await tmux(['list-panes', '-a', '-F', '#{session_name} #{pane_dead}']);
      // No server running yet means no session at all.
      if (result.status !== 0) {
        return [];
      }
      return result.stdout
        .split('\n')
        .flatMap((line): ObservedSession[] => {
          const [name = '', isDead = ''] = line.split(' ');
          const shipId = idSchema('ship').safeParse(name.slice(PREFIX.length));
          return name.startsWith(PREFIX) && shipId.success ? [{ shipId: shipId.data, status: isDead === '1' ? 'exited' : 'running' }] : [];
        });
    },
    stop: async (shipId) => {
      await tmux(['kill-session', '-t', `=${sessionName(shipId)}`]);
    },
    start: async ({ shipId, folder, command }) => {
      const name = sessionName(shipId);
      await tmux(['kill-session', '-t', `=${name}`]);
      // Start with the shell, keep the pane on exit, then run the command: so even a command that ends at once leaves its exit to see.
      await must(['new-session', '-d', '-s', name, '-c', folder, '-x', '200', '-y', '50']);
      await must(['set-option', '-w', '-t', `=${name}:`, 'remain-on-exit', 'on']);
      await must(['respawn-pane', '-k', '-t', `=${name}:`, '-c', folder, '--', ...command]);
    },
    type: async ({ shipId, text, settleMs }) => {
      const target = `=${sessionName(shipId)}:`;
      await must(['send-keys', '-t', target, '-l', text]);
      if (settleMs !== undefined) {
        await wait(settleMs);
      }
      await must(['send-keys', '-t', target, 'Enter']);
    },
    screen: async (shipId) => {
      const result = await tmux(['capture-pane', '-p', '-J', '-S', `-${String(SCREEN_LINES)}`, '-t', `=${sessionName(shipId)}:`]);
      return result.status === 0 ? result.stdout : '';
    },
  };
}
