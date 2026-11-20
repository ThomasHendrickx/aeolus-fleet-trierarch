import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TestProject } from 'vitest/node';
import { z } from 'zod';

import { TRIERARCH_UNDER_TEST } from './trierarch-under-test.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** What a GitHub Release of the suite's own carries: the Go trierarch built at the version after the one under test, and the signer that attests it with a Sigstore of a test's own. */
export interface ReleaseBuild {
  readonly version: string;
  readonly binary: string;
  readonly signer: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    release: ReleaseBuild;
  }
}

/** The version after this one: its patch one up. */
function nextOf(version: string): string {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  return `${String(major)}.${String(minor)}.${String(patch + 1)}`;
}

/** Builds the repository's Go binary and the next release used by upgrade tests. */
export function setup(project: TestProject): () => void {
  execFileSync('npm', ['run', 'build'], { cwd: REPOSITORY_ROOT, stdio: 'inherit' });
  const [program = '', ...words] = TRIERARCH_UNDER_TEST;
  const under = z.object({ version: z.string() }).parse(JSON.parse(execFileSync(program, [...words, '--version', '--json'], { encoding: 'utf8' }))).version;
  const version = nextOf(under);
  const folder = mkdtempSync(join(tmpdir(), 'trierarch-contract-release-'));
  try {
    const go = join(REPOSITORY_ROOT, 'go');
    const binary = join(folder, 'aeolus-trierarch');
    const signer = join(folder, 'testsigstore');
    execFileSync('go', ['build', '-ldflags', `-X github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/cli.Version=${version}`, '-o', binary, './cmd/aeolus-trierarch'], { cwd: go, stdio: 'inherit' });
    execFileSync('go', ['build', '-o', signer, './internal/testsigstore/cmd/testsigstore'], { cwd: go, stdio: 'inherit' });
    project.provide('release', { version, binary, signer });
  } catch (error) {
    rmSync(folder, { recursive: true, force: true });
    throw error;
  }
  return () => {
    rmSync(folder, { recursive: true, force: true });
  };
}
