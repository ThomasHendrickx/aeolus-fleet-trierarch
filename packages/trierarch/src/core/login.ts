/**
 * Which login a ship's session runs on (api keys K1, K5): an API key or its
 * harness's subscription, never both and never one falling back to the other
 * (K2). The configuration gives each harness a default and names the ships
 * that run on the other one; a harness with no default runs on its
 * subscription.
 */

export const LOGINS = ['apiKey', 'subscription'] as const;

export type Login = (typeof LOGINS)[number];

export interface Logins {
  /** A default login per harness, by harness name. */
  readonly default?: Readonly<Record<string, Login | undefined>>;
  /** A ship's own login, by ship name. */
  readonly ships?: Readonly<Record<string, Login>>;
}

export function loginOf(at: { logins?: Logins; harness: string; shipName: string }): Login {
  return at.logins?.ships?.[at.shipName] ?? at.logins?.default?.[at.harness] ?? 'subscription';
}

/** Where a harness's API key stands (api keys K8): none, ready, or held back by its vendor's answer. */
export const KEY_STATES = ['none', 'ready', 'refused', 'outOfCredit'] as const;

export type KeyState = (typeof KEY_STATES)[number];

/** A key's state, and since when for one its vendor's answer set (ISO 8601). */
export interface KeyStateAt {
  readonly state: KeyState;
  readonly at?: string;
}
