import { describe, expect, it } from 'vitest';

import { offeredRepositories, readTrustedRepositories } from './trusted-repositories.js';

const listOf = (repositories: readonly { name: unknown; url: unknown }[]) => JSON.stringify({ repositories });

describe('the trusted repositories a trierarch receives', () => {
  it('reads each name with its git URL', () => {
    const payload = listOf([
      { name: 'aeolus-fleet', url: 'https://github.com/ThomasHendrickx/aeolus-fleet.git' },
      { name: 'hemma', url: 'git@github.com:ThomasHendrickx/hemma.git' },
      { name: 'skills', url: 'ssh://git@github.com/ThomasHendrickx/skills.git' },
    ]);

    expect(readTrustedRepositories(payload)).toEqual({
      isOk: true,
      value: [
        { name: 'aeolus-fleet', url: 'https://github.com/ThomasHendrickx/aeolus-fleet.git' },
        { name: 'hemma', url: 'git@github.com:ThomasHendrickx/hemma.git' },
        { name: 'skills', url: 'ssh://git@github.com/ThomasHendrickx/skills.git' },
      ],
    });
  });

  it('reads none from an empty list', () => {
    expect(readTrustedRepositories('{"repositories":[]}')).toEqual({ isOk: true, value: [] });
  });

  it.each([
    ['a payload that is no JSON', 'hemma=git@github.com:a/b.git'],
    ['a payload without repositories', '{}'],
    ['a name that is a path', listOf([{ name: 'a/b', url: 'https://github.com/a/b.git' }])],
    ['a name given twice', listOf([{ name: 'hemma', url: 'https://github.com/a/b.git' }, { name: 'hemma', url: 'https://github.com/a/c.git' }])],
    ['a URL that is no text', listOf([{ name: 'hemma', url: 1 }])],
    ['a plain http URL', listOf([{ name: 'hemma', url: 'http://github.com/a/b.git' }])],
    ['a file URL', listOf([{ name: 'hemma', url: 'file:///srv/git/hemma.git' }])],
    ['a local path', listOf([{ name: 'hemma', url: '/srv/git/hemma.git' }])],
    ['a remote helper that runs a command', listOf([{ name: 'hemma', url: 'ext::sh -c touch% /tmp/x' }])],
    ['an https URL with a user and password', listOf([{ name: 'hemma', url: 'https://me:secret@github.com/a/b.git' }])],
    ['an https URL with a token as its user', listOf([{ name: 'hemma', url: 'https://ghp_token@github.com/a/b.git' }])],
    ['an ssh URL with a password', listOf([{ name: 'hemma', url: 'ssh://git:secret@github.com/a/b.git' }])],
    ['an ssh URL whose user reads as an option', listOf([{ name: 'hemma', url: 'ssh://-oProxyCommand=touch%20x@github.com/a/b.git' }])],
    ['an scp-like URL whose user reads as an option', listOf([{ name: 'hemma', url: '-oProxyCommand=x@github.com:a/b.git' }])],
    ['an scp-like URL whose host reads as an option', listOf([{ name: 'hemma', url: 'git@-oProxyCommand=x:a/b.git' }])],
    ['a URL that reads as an option', listOf([{ name: 'hemma', url: '--upload-pack=touch x' }])],
    ['a URL with a space', listOf([{ name: 'hemma', url: 'git@github.com:a/b c.git' }])],
  ])('refuses %s', (_label, payload) => {
    expect(readTrustedRepositories(payload)).toMatchObject({ isOk: false });
  });

  it('names the repository whose URL it refuses', () => {
    expect(readTrustedRepositories(listOf([{ name: 'hemma', url: 'file:///srv/git/hemma.git' }]))).toEqual({
      isOk: false,
      error: { reason: 'hemma: a trusted repository is an https:// or ssh URL, never a path, a file URL or a credential' },
    });
  });
});

describe('the repositories a trierarch offers with the trusted repositories', () => {
  const configured = { 'aeolus-fleet': { path: '/home/me/aeolus-fleet', checkouts: ['skills'] } };
  const cloneOf = (name: string) => `/home/me/.aeolus/trierarch/repositories/${name}`;

  it('offers each trusted repository beside the configured ones, at its clone', () => {
    expect(offeredRepositories(configured, { trusted: [{ name: 'hemma', url: 'git@github.com:ThomasHendrickx/hemma.git' }], cloneOf })).toEqual({
      'aeolus-fleet': { path: '/home/me/aeolus-fleet', checkouts: ['skills'] },
      hemma: { path: '/home/me/.aeolus/trierarch/repositories/hemma' },
    });
  });

  it('keeps a configured repository whose name is on the list as configured: the machine\'s own wins', () => {
    expect(offeredRepositories(configured, { trusted: [{ name: 'aeolus-fleet', url: 'https://github.com/ThomasHendrickx/aeolus-fleet.git' }], cloneOf })).toEqual(configured);
  });

  it('offers the configured ones alone with no trusted repositories', () => {
    expect(offeredRepositories(configured, { trusted: [], cloneOf })).toEqual(configured);
  });
});
