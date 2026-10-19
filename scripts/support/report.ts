import type { PullRequestRange } from './git.ts';

/**
 * Prints what a check found and sets the exit code: 0 when it found nothing,
 * 1 otherwise.
 */
export function report(check: { name: string; problems: readonly string[] }): void {
  if (check.problems.length === 0) {
    console.log(`${check.name}: ok`);
    return;
  }
  console.error(`${check.name}: ${String(check.problems.length)} problem(s)`);
  for (const problem of check.problems) {
    console.error(`- ${problem}`);
  }
  process.exitCode = 1;
}

/** Reads `<base> <head>` from the command line. Undefined unless there are exactly two. */
export function rangeFromArguments(args: readonly string[]): PullRequestRange | undefined {
  const [base, head] = args;
  return base && head && args.length === 2 ? { base, head } : undefined;
}

/** Runs a pull request check from the command line: `node <script> <base> <head>`. */
export function runPullRequestCheck(check: {
  name: string;
  problemsIn: (range: PullRequestRange) => readonly string[];
}): void {
  const range = rangeFromArguments(process.argv.slice(2));
  if (!range) {
    console.error(`Usage: node ${process.argv[1] ?? '<script>'} <base commit> <head commit>`);
    process.exitCode = 2;
    return;
  }
  report({ name: check.name, problems: check.problemsIn(range) });
}
