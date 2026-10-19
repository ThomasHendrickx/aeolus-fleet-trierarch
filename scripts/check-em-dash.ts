/**
 * CI check: no em dash (U+2014) in what a pull request adds, nor in its commit
 * messages (CLAUDE.md, "House rules"). Lines it removes may hold one.
 *
 * Usage: node scripts/check-em-dash.ts <base commit> <head commit>
 */
import { git, repositoryRoot, type PullRequestRange } from './support/git.ts';
import { runPullRequestCheck } from './support/report.ts';

export const EM_DASH = '\u2014';

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const RECORD_SEPARATOR = '\u001e';
const UNIT_SEPARATOR = '\u001f';

export function emDashProblems(repository: string, range: PullRequestRange): string[] {
  return [
    ...inAddedLines(repository, range),
    ...inFileNames(repository, range),
    ...inCommitMessages(repository, range),
  ];
}

function inAddedLines(repository: string, range: PullRequestRange): string[] {
  const diff = git(repository, [
    '-c',
    'core.quotePath=off',
    'diff',
    '--unified=0',
    '--no-color',
    '--no-ext-diff',
    `${range.base}...${range.head}`,
  ]);

  const problems: string[] = [];
  let file = '';
  let line = 0;
  for (const text of diff.split('\n')) {
    if (text.startsWith('+++ ')) {
      file = text.slice('+++ b/'.length);
      continue;
    }
    const hunk = HUNK_HEADER.exec(text);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (text.startsWith('+')) {
      if (text.includes(EM_DASH)) {
        problems.push(`${file}:${String(line)} adds an em dash: ${text.slice(1).trim()}`);
      }
      line += 1;
    }
  }
  return problems;
}

function inFileNames(repository: string, range: PullRequestRange): string[] {
  return git(repository, ['diff', '--name-only', '--diff-filter=AR', '-z', `${range.base}...${range.head}`])
    .split('\0')
    .filter((file) => file.includes(EM_DASH))
    .map((file) => `${file} has an em dash in its name`);
}

function inCommitMessages(repository: string, range: PullRequestRange): string[] {
  return git(repository, ['log', `--format=%H${UNIT_SEPARATOR}%B${RECORD_SEPARATOR}`, `${range.base}..${range.head}`])
    .split(RECORD_SEPARATOR)
    .map((record) => record.trim().split(UNIT_SEPARATOR))
    .filter(([, message]) => message?.includes(EM_DASH))
    .map(([hash = '']) => `commit ${hash.slice(0, 12)} has an em dash in its message`);
}

if (import.meta.main) {
  runPullRequestCheck({ name: 'No em dash', problemsIn: (range) => emDashProblems(repositoryRoot, range) });
}
