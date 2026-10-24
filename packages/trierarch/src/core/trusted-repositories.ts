/**
 * The trusted repositories (aeolus-fleet#384): the trierarch plugin's one
 * list of the repositories a trierarch may clone on demand, each by the name
 * a crew request's workspace gives it and its git URL. A trierarch reads the
 * list it receives as strictly as the trierarch plugin wrote it: a URL never
 * holds a credential, and is never a path, a file URL or a remote helper, so
 * a clone uses only the access the machine holds.
 */
import { trierarchNameSchema } from '@aeolus-fleet/common';
import { z } from 'zod';

import { err, ok, type Result } from './shared/result.js';

/** A repository a trierarch may clone on demand: its name and its git URL. */
export interface TrustedRepository {
  readonly name: string;
  readonly url: string;
}

/** The content type of the message that carries the list from the trierarch plugin. */
export const TRUSTED_REPOSITORIES_CONTENT_TYPE = 'application/vnd.aeolus.trierarch.trusted-repositories+json';

/** The content type of the message a trierarch asks the trierarch plugin's ship for the list again with. */
export const TRUSTED_REPOSITORIES_REQUEST_CONTENT_TYPE = 'application/vnd.aeolus.trierarch.trusted-repositories-request+json';

const URL_REFUSED = 'a trusted repository is an https:// or ssh URL, never a path, a file URL or a credential';

/**
 * git's scp-like ssh form, `user@host:path`. Neither user, host nor path may
 * start with `-`, which ssh would read as an option.
 */
const SCP_LIKE = /^[A-Za-z0-9_][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*:[^\s-]\S*$/;

/** Whether the URL's user reads as an ssh option once decoded; a user that does not decode is no user git can take either. */
function isOptionUser(username: string): boolean {
  try {
    return decodeURIComponent(username).startsWith('-');
  } catch {
    return true;
  }
}

/**
 * Whether git may clone from the URL with the machine's own access: https
 * with no user (a user there is a token), or ssh with no password and no user
 * or host that reads as an option.
 */
function isCloneable(url: string): boolean {
  if (/\s/.test(url)) {
    return false;
  }
  if (SCP_LIKE.test(url)) {
    return true;
  }
  if (!URL.canParse(url)) {
    return false;
  }
  const parsed = new URL(url);
  const hasRepository = parsed.pathname.length > 1;
  const hasSafeHost = parsed.hostname !== '' && !parsed.hostname.startsWith('-');
  if (parsed.protocol === 'https:') {
    return hasRepository && hasSafeHost && parsed.username === '' && parsed.password === '';
  }
  if (parsed.protocol === 'ssh:') {
    return hasRepository && hasSafeHost && parsed.password === '' && !isOptionUser(parsed.username);
  }
  return false;
}

const payloadSchema = z.object({ repositories: z.array(z.object({ name: z.unknown(), url: z.unknown() })) });

/** The list from the message's payload, or why not: each name a trierarch name given once, each URL one git clones with the machine's access. */
export function readTrustedRepositories(payload: string): Result<readonly TrustedRepository[], { reason: string }> {
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return err({ reason: 'the trusted repositories are not JSON' });
  }
  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) {
    return err({ reason: 'the trusted repositories are { "repositories": [{ "name", "url" }] }' });
  }
  const repositories: TrustedRepository[] = [];
  for (const { name, url } of parsed.data.repositories) {
    const named = trierarchNameSchema.safeParse(name);
    if (!named.success) {
      return err({ reason: `${String(name)}: ${named.error.issues[0]?.message ?? 'not a name'}` });
    }
    if (repositories.some((each) => each.name === named.data)) {
      return err({ reason: `${named.data}: a trusted repository is named once` });
    }
    if (typeof url !== 'string' || !isCloneable(url)) {
      return err({ reason: `${named.data}: ${URL_REFUSED}` });
    }
    repositories.push({ name: named.data, url });
  }
  return ok(repositories);
}

/**
 * The repositories the trierarch offers and crews in: its configured ones,
 * and each trusted repository beside them at its clone, cloned on its first
 * workspace. A configured repository whose name is on the list stays as the
 * machine configured it.
 */
export function offeredRepositories<R extends { readonly path: string }>(
  configured: Readonly<Record<string, R>>,
  at: { trusted: readonly TrustedRepository[]; cloneOf: (name: string) => string },
): Readonly<Record<string, R | { readonly path: string }>> {
  const cloned = at.trusted.filter(({ name }) => !(name in configured)).map(({ name }) => [name, { path: at.cloneOf(name) }] as const);
  return { ...configured, ...Object.fromEntries(cloned) };
}
