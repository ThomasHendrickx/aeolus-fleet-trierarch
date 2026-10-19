/**
 * The notes of a GitHub Release, built from the merged pull requests that carry
 * the release's label (the version, such as `0.13.0`): each by its title with a
 * link, grouped by its conventional commit type. Git and the labels are the
 * source; there is no changelog file. Used by the release workflow.
 *
 * Usage: gh pr list --state merged --label <version> --json number,title,url --limit 1000 \
 *          | node scripts/release-notes.ts <version>
 */
import { readFileSync } from 'node:fs';

import { z } from 'zod';

export interface PullRequest {
  number: number;
  title: string;
  url: string;
}

/** The groups by type, in the order they are shown; a title of any other type goes under OTHER_CHANGES, last. */
const GROUPS = [
  { heading: 'Features', type: /^feat(\([^)]*\))?!?: / },
  { heading: 'Fixes', type: /^fix(\([^)]*\))?!?: / },
] as const;
const OTHER_CHANGES = 'Other changes';

const pullRequestsSchema = z.array(z.object({ number: z.number(), title: z.string(), url: z.string() }));

export function releaseNotes(release: { version: string; pullRequests: readonly PullRequest[] }): string {
  if (release.pullRequests.length === 0) {
    return `No merged pull request carries the label ${release.version}.\n`;
  }
  const oldestFirst = release.pullRequests.toSorted((one, other) => one.number - other.number);
  const grouped = new Map<string, PullRequest[]>([...GROUPS.map(({ heading }) => heading), OTHER_CHANGES].map((heading) => [heading, []]));
  for (const pullRequest of oldestFirst) {
    const heading = GROUPS.find(({ type }) => type.test(pullRequest.title))?.heading ?? OTHER_CHANGES;
    grouped.get(heading)?.push(pullRequest);
  }
  return [...grouped]
    .filter(([, pullRequests]) => pullRequests.length > 0)
    .map(([heading, pullRequests]) => [`## ${heading}`, '', ...pullRequests.map(({ number, title, url }) => `- ${title} ([#${String(number)}](${url}))`), ''].join('\n'))
    .join('\n');
}

if (import.meta.main) {
  try {
    const version = process.argv[2] ?? '';
    if (version === '') {
      throw new Error('Usage: node scripts/release-notes.ts <version>, with the pull requests as JSON on stdin');
    }
    const pullRequests = pullRequestsSchema.parse(JSON.parse(readFileSync(0, 'utf8')));
    process.stdout.write(releaseNotes({ version, pullRequests }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
