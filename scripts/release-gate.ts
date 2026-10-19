/**
 * Whether a commit may be released: from main or hotfix/<major>.<minor>.x, and only when CI's run
 * for that exact commit on the same branch passed. Release runs no tests of its own (ADR
 * 0011); this reads the result CI already has, so the gate holds without a
 * second test run. Used by the release workflow, which fails with the reason.
 *
 * Usage: gh run list --workflow ci.yml --commit <sha> --branch <branch> --event push --json status,conclusion,url \
 *          | node scripts/release-gate.ts <ref> <sha>
 */
import { readFileSync } from 'node:fs';

import { z } from 'zod';

const MAIN = 'refs/heads/main';
const HOTFIX = /^refs\/heads\/hotfix\/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.x$/;

const ciRunSchema = z.object({ status: z.string(), conclusion: z.string(), url: z.string() });

export type CiRun = z.infer<typeof ciRunSchema>;

/** Why the commit may not be released, or undefined when it may. The runs are CI's runs for the commit, newest first, as gh lists them. */
export function releaseRefusal(release: { ref: string; sha: string; runs: readonly CiRun[] }): string | undefined {
  if (release.ref !== MAIN && !HOTFIX.test(release.ref)) {
    return `A release runs only from main or hotfix/<major>.<minor>.x, not from ${release.ref}`;
  }
  const [newest] = release.runs;
  if (newest === undefined) {
    return `CI has not run on ${release.sha} on ${release.ref.slice('refs/heads/'.length)}, so it cannot be released`;
  }
  if (newest.status !== 'completed') {
    return `CI on ${release.sha} has not finished yet: ${newest.url}`;
  }
  if (newest.conclusion !== 'success') {
    return `CI on ${release.sha} did not pass (${newest.conclusion}): ${newest.url}`;
  }
  return undefined;
}

if (import.meta.main) {
  try {
    const [ref = '', sha = ''] = process.argv.slice(2);
    if (ref === '' || sha === '') {
      throw new Error("Usage: node scripts/release-gate.ts <ref> <sha>, with CI's runs for the commit as JSON on stdin");
    }
    const refusal = releaseRefusal({ ref, sha, runs: z.array(ciRunSchema).parse(JSON.parse(readFileSync(0, 'utf8'))) });
    if (refusal !== undefined) {
      console.error(`::error::${refusal}`);
      process.exit(1);
    }
    console.log(`CI passed on ${sha} on ${ref.slice('refs/heads/'.length)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
