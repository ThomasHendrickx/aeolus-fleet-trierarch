import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTemporaryRepository, type TemporaryRepository } from './support/temporary-repository.ts';

/** The workflow whose changed-paths step decides which pull requests run the contract and integration jobs. */
const CI = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

/** The lines of a job's block: from `  <job>:` to the next job. */
function jobOf(name: string): string[] {
  const lines = CI.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  if (start === -1) {
    return [];
  }
  const end = lines.findIndex((line, index) => index > start && /^ {2}\S/.test(line));
  return lines.slice(start, end === -1 ? undefined : end);
}

/** The shell script of the step with this id, as the workflow runs it. */
function scriptOf(job: string, id: string): string {
  const lines = jobOf(job);
  const step = lines.findIndex((line) => line.trim() === `- id: ${id}`);
  const run = lines.findIndex((line, index) => index > step && line.trim() === 'run: |');
  if (step === -1 || run === -1) {
    return '';
  }
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== '' && !line.startsWith(' '.repeat(10))) {
      break;
    }
    body.push(line.slice(10));
  }
  return body.join('\n');
}

const CHANGED_PATHS = 'changed-paths';

/** What a push or a pull request makes the step answer, by the outputs it writes. */
function answer(event: 'push' | 'pull_request', range: { base: string; head: string }): Record<string, string> {
  const folder = mkdtempSync(join(tmpdir(), 'aeolus-ci-paths-'));
  const output = join(folder, 'output');
  try {
    const ran = spawnSync('bash', ['-c', scriptOf(CHANGED_PATHS, 'paths')], {
      cwd: repository.path,
      encoding: 'utf8',
      env: { ...process.env, EVENT: event, BASE: range.base, HEAD: range.head, GITHUB_OUTPUT: output },
    });
    expect(ran.status, ran.stderr).toBe(0);
    const lines = readFileSync(output, 'utf8').split('\n').filter((line) => line !== '');
    return Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * What the contract job reads: the Go trierarch it builds, the suite and its stand-ins, the plugin's
 * scripts and manifests the stand-in harnesses run and the trierarch reads, what `npm run build` of
 * the trierarch compiles, and the runner's own inputs.
 */
const SHARED = [
  'package.json',
  'package-lock.json',
  'vitest.config.ts',
  'tsconfig.json',
  'tsconfig.base.json',
  'scripts/support/test-folders.global-setup.ts',
  'scripts/support/test-folders.ts',
  '.github/actions/test-images/action.yml',
  '.github/workflows/ci.yml',
  'go/internal/cli/cli.go',
  'contract/run.integration.test.ts',
  'contract/support/machine.ts',
  'plugins/aeolus-fleet/scripts/aeolus-turn.sh',
  'plugins/aeolus-fleet/.claude-plugin/plugin.json',
  'plugins/aeolus-fleet/.codex-plugin/plugin.json',
  'plugins/aeolus-fleet/.github/plugin/plugin.json',
];

/** What only the integration job reads: the trierarch's and the plugin's own integration tests and what they import. */
const INTEGRATION_ONLY = [
  'plugins/aeolus-fleet/test/delivery.integration.test.ts',
  'plugins/aeolus-fleet/test/script-environment.ts',
  'plugins/aeolus-fleet/test/foreign-harness.setup.ts',
];

/** What neither job reads: docs, a plugin's prose and tests, the session image, other workflows, and tests of the units. */
const NEITHER = [
  'docs/design/harnesses.md',
  'README.md',
  'AGENTS.md',
  'plugins/aeolus-fleet/README.md',
  'plugins/aeolus-fleet/skills/crew/SKILL.md',
  'plugins/aeolus-fleet/commands/crew.md',
  'plugins/aeolus-fleet/copilot-skills/crew/SKILL.md',
  'plugins/aeolus-fleet/hooks/hooks.json',
  'plugins/aeolus-fleet/test/ask.test.ts',
  'image/Containerfile',
  'image/session-init.sh',
  '.github/workflows/release.yml',
  '.github/workflows/go-binaries.yml',
  'scripts/check-em-dash.ts',
  'e2e/plugin-session.e2e.test.ts',
  'lint/all-packages.test.ts',
  'homebrew/aeolus-trierarch.rb',
  'install.sh',
  '.claude/skills/typescript/SKILL.md',
];

let repository: TemporaryRepository;
let base: string;

beforeEach(() => {
  repository = createTemporaryRepository();
  repository.write('README.md', 'base\n');
  base = repository.commit('base');
});

afterEach(() => {
  repository.dispose();
});

/** A pull request branch that changes one file, answered as the step answers it. */
function pullRequestChanging(file: string): Record<string, string> {
  repository.git(['checkout', '--quiet', '-b', 'change', base]);
  repository.write(file, `changed ${file}\n`);
  const head = repository.commit(`change ${file}`);
  const answered = answer('pull_request', { base: base, head: head });
  repository.git(['checkout', '--quiet', 'main']);
  repository.git(['branch', '--quiet', '-D', 'change']);
  return answered;
}

describe('the changed paths step of CI', () => {
  it('runs both jobs on every push, whatever the push changes', () => {
    repository.write('docs/design/harnesses.md', 'docs only\n');
    const head = repository.commit('docs');

    expect(answer('push', { base: base, head: head })).toEqual({ contract: 'true', integration: 'true' });
  });

  it('runs both jobs on a push that creates a branch, which has no earlier commit to compare with', () => {
    expect(answer('push', { base: '0'.repeat(40), head: base })).toEqual({ contract: 'true', integration: 'true' });
  });

  it.each(SHARED)('runs both jobs on a pull request that changes %s', (file) => {
    expect(pullRequestChanging(file)).toEqual({ contract: 'true', integration: 'true' });
  });

  it.each(INTEGRATION_ONLY)('runs only the integration job on a pull request that changes %s', (file) => {
    expect(pullRequestChanging(file)).toEqual({ contract: 'false', integration: 'true' });
  });

  it.each(NEITHER)('runs neither job on a pull request that changes only %s', (file) => {
    expect(pullRequestChanging(file)).toEqual({ contract: 'false', integration: 'false' });
  });

  it('runs both jobs on a pull request that deletes a file they read', () => {
    repository.write('contract/run.integration.test.ts', 'a test\n');
    const withTest = repository.commit('add a contract test');
    repository.git(['checkout', '--quiet', '-b', 'change', withTest]);
    repository.remove('contract/run.integration.test.ts');
    const head = repository.commit('delete it');

    expect(answer('pull_request', { base: withTest, head: head })).toEqual({ contract: 'true', integration: 'true' });
  });

  it('compares a pull request with where its branch left main, not with main as it is now', () => {
    repository.git(['checkout', '--quiet', '-b', 'change', base]);
    repository.write('docs/design/harnesses.md', 'docs only\n');
    const head = repository.commit('docs');
    repository.git(['checkout', '--quiet', 'main']);
    repository.write('go/internal/cli/cli.go', 'main moved on\n');
    const moved = repository.commit('main moves on in Go');

    expect(answer('pull_request', { base: moved, head: head })).toEqual({ contract: 'false', integration: 'false' });
  });
});

describe('the path lists in the workflow', () => {
  /** Each path of a list, the line before it, and whether that line is a comment. */
  function entries(): { path: string; reason: string | undefined }[] {
    const lines = scriptOf(CHANGED_PATHS, 'paths').split('\n');
    const found: { path: string; reason: string | undefined }[] = [];
    let isInList = false;
    lines.forEach((line, index) => {
      if (/^\s*[a-z_]+=\($/.test(line)) {
        isInList = true;
      } else if (/^\s*\)$/.test(line)) {
        isInList = false;
      } else if (isInList && !line.trim().startsWith('#') && line.trim() !== '') {
        const before = lines[index - 1]?.trim() ?? '';
        found.push({ path: line.trim(), reason: before.startsWith('#') ? before : undefined });
      }
    });
    return found;
  }

  it('lists paths in the workflow itself', () => {
    expect(entries().length).toBeGreaterThan(10);
  });

  it('gives every path a one-line reason', () => {
    expect(entries().filter((entry) => entry.reason === undefined).map((entry) => entry.path)).toEqual([]);
  });
});

describe('the gated jobs of CI', () => {
  it('has no workflow level path filter, which leaves a required check pending when it skips the workflow', () => {
    const on = CI.slice(CI.indexOf('\non:'), CI.indexOf('\npermissions:'));

    expect(on).not.toMatch(/^\s+paths(-ignore)?:/m);
  });

  it.each([
    ['contract-go', 'contract'],
    ['integration', 'integration'],
  ])('runs %s only when its paths changed, by an if on the job, which a required check counts as passed when skipped', (job, output) => {
    const block = jobOf(job).join('\n');

    expect(block).toMatch(new RegExp(`^ {4}needs: ${CHANGED_PATHS}$`, 'm'));
    expect(block).toContain(`needs.${CHANGED_PATHS}.outputs.${output} == 'true'`);
  });

  it.each(['contract-go', 'integration'])('runs %s when the changed paths step failed, so a failure there never skips it', (job) => {
    const block = jobOf(job).join('\n');

    expect(block).toMatch(/^ {4}if: \$\{\{ always\(\) && \(needs\.changed-paths\.result != 'success' \|\|/m);
    expect(block).toContain('exit 1');
  });
});
