/**
 * Whether a commit's staging walk lets it be released (decision 0011): the walker
 * sets the commit status staging-walk on the candidate's commit, its description '<version>: <passed|blocked>, candidate run <id>',
 * and only a passed walk of the candidate run and version the release publishes lets it through. Thomas, the
 * repository owner, can overrule a failed or missing walk by dispatching the release with a reason; the release writes the
 * reason into its log and the GitHub Release's notes.
 *
 * Usage: gh api repos/<owner>/<repo>/commits/<sha>/statuses \
 *          | node scripts/staging-walk-gate.ts <sha> <owner> <actor> <version> <candidate run id> [<override reason>]
 */
import { readFileSync } from 'node:fs';

import { z } from 'zod';

const CONTEXT = 'staging-walk';

const commitStatusSchema = z.object({ context: z.string(), state: z.string(), target_url: z.string().nullable(), description: z.string().nullable() });

export type CommitStatus = z.infer<typeof commitStatusSchema>;

export type StagingWalkVerdict =
  | { verdict: 'walked'; url: string | null }
  | { verdict: 'overruled'; reason: string }
  | { verdict: 'refused'; why: string };

/** The verdict on a commit; the statuses are GitHub's for the commit, newest first, as its API lists them. */
export function stagingWalkVerdict(release: {
  sha: string;
  version: string;
  candidateRunId: string;
  owner: string;
  actor: string;
  overrideReason: string;
  statuses: readonly CommitStatus[];
}): StagingWalkVerdict {
  const reason = release.overrideReason.trim();
  if (reason !== '') {
    return release.actor === release.owner
      ? { verdict: 'overruled', reason }
      : { verdict: 'refused', why: `Only ${release.owner} overrules the staging walk; ${release.actor} dispatched this release` };
  }
  const walked = `${release.version}: `;
  const walk = release.statuses.find(
    ({ context, description }) =>
      context === CONTEXT &&
      description !== null &&
      description.startsWith(walked) &&
      description.endsWith(`, candidate run ${release.candidateRunId}`) &&
      /^(passed|blocked)$/.test(description.slice(walked.length, description.length - `, candidate run ${release.candidateRunId}`.length)),
  );
  const subject = `candidate run ${release.candidateRunId} at ${release.version}`;
  if (walk === undefined) {
    return { verdict: 'refused', why: `No staging walk of ${subject} on ${release.sha}: the walker has not reported on it` };
  }
  const reported = walk.state === 'success' && walk.description?.startsWith(`${walked}blocked,`) === true ? 'blocked' : walk.state;
  if (reported !== 'success') {
    return { verdict: 'refused', why: `The staging walk of ${subject} did not pass (${reported}): ${walk.target_url ?? 'no link'}` };
  }
  return { verdict: 'walked', url: walk.target_url };
}

if (import.meta.main) {
  try {
    const [sha = '', owner = '', actor = '', version = '', candidateRunId = '', overrideReason = ''] = process.argv.slice(2);
    if (sha === '' || owner === '' || actor === '' || version === '' || candidateRunId === '') {
      throw new Error("Usage: node scripts/staging-walk-gate.ts <sha> <owner> <actor> <version> <candidate run id> [<override reason>], with the commit's statuses as JSON on stdin");
    }
    const statuses = z.array(commitStatusSchema).parse(JSON.parse(readFileSync(0, 'utf8')));
    const result = stagingWalkVerdict({ sha, version, candidateRunId, owner, actor, overrideReason, statuses });
    if (result.verdict === 'refused') {
      console.error(`::error::${result.why}`);
      process.exit(1);
    }
    console.log(
      result.verdict === 'overruled'
        ? `::warning::${owner} overruled the staging walk of ${sha}: ${result.reason}`
        : `The staging walk of candidate run ${candidateRunId} at ${version} passed: ${result.url ?? 'no link'}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
