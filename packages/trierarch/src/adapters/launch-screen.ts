import type { LaunchSeen } from '../core/ports.js';

/** The texts a harness writes to its screen in a session's launch window (#382), each adapter its own. */
export interface LaunchTexts {
  /** A line that shows a tool call, done or under way. */
  readonly activity: RegExp;
  /** The refusal of a model, with the id it refused as its first group; global, so every refusal is seen. */
  readonly refused: RegExp;
  /** The harness's screens a session can stop at before its first prompt runs (#403), each by its name and a text only it shows. */
  readonly screens: readonly { readonly name: string; readonly text: RegExp }[];
}

/**
 * What the screen shows: the model refused, when a refusal names the one it
 * launched with (or any, when it launched with none, so the CLI's own
 * default); else activity when a tool line shows; else none, naming the
 * known screen it stopped at when one shows. A refusal of another id is only
 * text, as when a ship discusses one.
 */
export function launchSeenWith(texts: LaunchTexts, at: { screen: string; model?: string }): LaunchSeen {
  for (const [, id] of at.screen.matchAll(texts.refused)) {
    if (id !== undefined && (at.model === undefined || id === at.model)) {
      return { kind: 'refused', model: id };
    }
  }
  if (texts.activity.test(at.screen)) {
    return { kind: 'active' };
  }
  const stopped = texts.screens.find((screen) => screen.text.test(at.screen));
  return stopped === undefined ? { kind: 'none' } : { kind: 'none', screen: stopped.name };
}
