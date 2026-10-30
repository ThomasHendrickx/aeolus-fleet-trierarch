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

/** The login of a ship's earlier session, until the start that changed it (ISO 8601). */
export interface EarlierLogin {
  readonly login: Login;
  readonly until: string;
}

/**
 * The logins a ship's sessions ran on (api keys K8): its running or last
 * session's, and its earlier sessions' oldest first, each kept only when a
 * start changed it, so the list grows with changes of login, not restarts.
 */
export interface SessionLogins {
  readonly login: Login;
  readonly earlierLogins?: readonly EarlierLogin[];
}

/** The login of the session that ran at the time (K8): what a transcript message written then counts to. */
export function loginAt(logins: SessionLogins, time: Date): Login {
  return logins.earlierLogins?.find(({ until }) => time.getTime() < Date.parse(until))?.login ?? logins.login;
}

/** The logins once a session started on the login at the time: the one before kept while it differs. */
export function startedOn(logins: Partial<SessionLogins>, start: { login: Login; at: string }): SessionLogins {
  const { login, earlierLogins } = logins;
  const kept = login === undefined || login === start.login ? earlierLogins : [...(earlierLogins ?? []), { login, until: start.at }];
  return { login: start.login, ...(kept !== undefined && { earlierLogins: kept }) };
}

/** Where a harness's API key stands (api keys K8): none, ready, or held back by its vendor's answer. */
export const KEY_STATES = ['none', 'ready', 'refused', 'outOfCredit'] as const;

export type KeyState = (typeof KEY_STATES)[number];

/** A key's state, and since when for one its vendor's answer set (ISO 8601). */
export interface KeyStateAt {
  readonly state: KeyState;
  readonly at?: string;
}
