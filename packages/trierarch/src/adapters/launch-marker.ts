import type { AeolusPlugin } from './plugin-identity.js';
import { runIdentity } from './plugin-identity.js';

/**
 * The launch marker the aeolus plugin's hooks keep for a session the
 * trierarch started with a launch id (#490), read and cleared through the
 * plugin's own `aeolus-identity.sh launch`, never a copy of how the plugin
 * names its files. Its first line is the launch id, then one line per event
 * with when: `started` with the transcript, `active`, and `refused` with the
 * model id the refusal names when it names one.
 */
export interface LaunchMarker {
  readonly isStarted: boolean;
  /** The transcript the harness keeps of the session, as its session start named it; for Codex its session log. */
  readonly transcript?: string;
  readonly isActive: boolean;
  /** Set once a turn failed because the model was not found, with the model's id when the refusal named it. */
  readonly refused?: { readonly model?: string };
}

/** The exit of a plugin script that does not know the command it was given, as an aeolus plugin older than the launch marker answers `launch`. */
const USAGE_EXIT = 2;

/** What the marker text says of the launch given; none when it is of another launch. */
export function launchMarkerOf(text: string, launchId: string): LaunchMarker | undefined {
  const [first, ...events] = text.split('\n');
  if (first !== `launch ${launchId}`) {
    return undefined;
  }
  const event = (name: string) => events.find((line) => line.startsWith(`${name} `))?.split(' ');
  const started = event('started');
  // Everything after when, as a path may hold spaces.
  const transcript = started?.slice(2).join(' ');
  const refused = event('refused');
  const model = refused?.[2];
  return {
    isStarted: started !== undefined,
    ...(transcript !== undefined && transcript !== '' && { transcript }),
    isActive: event('active') !== undefined,
    ...(refused !== undefined && { refused: model === undefined || model === '' ? {} : { model } }),
  };
}

export interface LaunchMarks {
  /** Forgets the folder's marker, before a session is started for a new launch. */
  clear(folder: string): Promise<void>;
  /** What the folder's marker says of the launch given; none before the hooks marked anything of it. */
  read(at: { folder: string; launchId: string }): Promise<LaunchMarker | undefined>;
  /** Whether the plugin keeps launch markers: one older than them answers `launch` with its usage. */
  isMarking(): Promise<boolean>;
}

export function createLaunchMarks(plugin: AeolusPlugin): LaunchMarks {
  return {
    clear: async (folder) => {
      const cleared = await runIdentity(plugin, { folder, args: ['launch', 'clear'] });
      if (cleared.status !== 0) {
        throw new Error(`aeolus-identity.sh launch clear failed: ${cleared.stderr.trim()}`);
      }
    },
    read: async ({ folder, launchId }) => {
      const marker = await runIdentity(plugin, { folder, args: ['launch'] });
      return marker.status === 0 ? launchMarkerOf(marker.stdout, launchId) : undefined;
    },
    // Asked for the crews folder itself, which no session crews, so the answer is only whether the command is known.
    isMarking: async () => (await runIdentity(plugin, { folder: plugin.crews, args: ['launch'] })).status !== USAGE_EXIT,
  };
}
