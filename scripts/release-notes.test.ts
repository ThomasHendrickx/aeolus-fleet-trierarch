import { describe, expect, it } from 'vitest';

import { releaseNotes } from './release-notes.ts';

function aPullRequest(number: number, title: string): { number: number; title: string; url: string } {
  return { number, title, url: `https://github.com/acme/aeolus/pull/${String(number)}` };
}

describe('the release notes', () => {
  it('lists each pull request carrying the label by its title, linked', () => {
    expect(releaseNotes({ version: '0.13.0', pullRequests: [aPullRequest(192, 'feat: the installation API')] })).toBe(
      ['## Features', '', '- feat: the installation API ([#192](https://github.com/acme/aeolus/pull/192))', ''].join('\n'),
    );
  });

  it('groups features, fixes and everything else, in that order, each oldest first', () => {
    const notes = releaseNotes({
      version: '0.13.0',
      pullRequests: [
        aPullRequest(195, 'docs(squadrons): the how-to'),
        aPullRequest(194, 'fix(web): a menu'),
        aPullRequest(193, 'feat(server)!: hosted sign-in'),
        aPullRequest(191, 'feat: limits'),
        aPullRequest(190, 'chore: tidy'),
      ],
    });
    expect(notes).toBe(
      [
        '## Features',
        '',
        '- feat: limits ([#191](https://github.com/acme/aeolus/pull/191))',
        '- feat(server)!: hosted sign-in ([#193](https://github.com/acme/aeolus/pull/193))',
        '',
        '## Fixes',
        '',
        '- fix(web): a menu ([#194](https://github.com/acme/aeolus/pull/194))',
        '',
        '## Other changes',
        '',
        '- chore: tidy ([#190](https://github.com/acme/aeolus/pull/190))',
        '- docs(squadrons): the how-to ([#195](https://github.com/acme/aeolus/pull/195))',
        '',
      ].join('\n'),
    );
  });

  it('says so when no pull request carries the label', () => {
    expect(releaseNotes({ version: '0.13.1', pullRequests: [] })).toBe('No merged pull request carries the label 0.13.1.\n');
  });
});
