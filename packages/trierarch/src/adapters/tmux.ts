import { idSchema, type ShipId } from '@aeolus-fleet/common';

import type { ObservedSession, SessionRuntime } from '../core/ports.js';
import { runCommand } from './run-command.js';

const PREFIX = 'trierarch-';
export const TMUX_SERVER = 'aeolus-trierarch';

/**
 * The sessions a trierarch before headless sessions started on the host
 * (headless H4, H19): one tmux session per ship on its own tmux server
 * (`tmux -L aeolus-trierarch`), named after its ship id. The trierarch no
 * longer starts any; it lists them, as of another version, so each is
 * replaced by a hold once its turn is idle, and stops them. Without a server
 * running there are none.
 */
export function createTmux(options: { server?: string } = {}): Pick<SessionRuntime, 'list' | 'stop'> {
  const server = options.server ?? TMUX_SERVER;
  const tmux = (args: readonly string[]) => runCommand('tmux', { args: ['-L', server, ...args] }).catch(() => ({ status: 1, stdout: '', stderr: 'tmux does not run here' }));
  return {
    list: async () => {
      const result = await tmux(['list-panes', '-a', '-F', '#{session_name} #{pane_dead}']);
      if (result.status !== 0) {
        return [];
      }
      return result.stdout.split('\n').flatMap((line): ObservedSession[] => {
        const [name = '', isDead = ''] = line.split(' ');
        const shipId = idSchema('ship').safeParse(name.slice(PREFIX.length));
        return name.startsWith(PREFIX) && shipId.success ? [{ shipId: shipId.data, status: isDead === '1' ? 'exited' : 'running' }] : [];
      });
    },
    stop: async (shipId: ShipId) => {
      await tmux(['kill-session', '-t', `=${PREFIX}${shipId}`]);
    },
  };
}
