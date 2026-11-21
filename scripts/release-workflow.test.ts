import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const RELEASE = '../.github/workflows/release.yml';
const FINISH = '../.github/workflows/finish-release.yml';

function workflow(path: string): string {
  const url = new URL(path, import.meta.url);
  return existsSync(url) ? readFileSync(url, 'utf8') : '';
}

/** Each step of the workflow's jobs as its text: from its `- ` at six spaces to the next step or the end of its job. */
function steps(text: string): string[] {
  const found: string[] = [];
  let current: string[] | undefined;
  for (const line of text.split('\n')) {
    if (/^ {6}- /.test(line)) {
      current = [line];
      found.push('');
    } else if (current !== undefined && (line.trim() === '' || /^ {7,}/.test(line))) {
      current.push(line);
    } else {
      current = undefined;
    }
    if (current !== undefined) {
      found[found.length - 1] = current.join('\n');
    }
  }
  return found;
}

function stepNames(): string[] {
  return [...workflow(FINISH).matchAll(/^ {6}- name: (.+)$/gm)].map((match) => match[1] ?? '');
}

function stepIndex(prefix: string): number {
  return stepNames().findIndex((name) => name.startsWith(prefix));
}

function stepNamed(text: string, prefix: string): string {
  return steps(text).find((step) => step.startsWith(`      - name: ${prefix}`)) ?? '';
}

describe('the release workflow', () => {
  it('updates the Homebrew tap after the plugin version is set on main, so a tap failure leaves the plugin step run', () => {
    const plugin = stepIndex('Set the aeolus-fleet plugin to');
    const tap = stepIndex('Update the Homebrew tap to');
    expect(plugin).toBeGreaterThan(-1);
    expect(tap).toBeGreaterThan(plugin);
  });

  it.each([RELEASE, FINISH])('names the repository with GH_REPO in every step of %s that runs gh, wherever the step runs', (path) => {
    const withGh = steps(workflow(path)).filter((step) => /\bgh (api|attestation|pr|release|run)\b/.test(step));
    expect(withGh.length).toBeGreaterThan(0);
    for (const step of withGh) {
      expect(step).toMatch(/^ +GH_REPO: \$\{\{ github\.repository \}\}$/m);
    }
  });

  it('finishes its release through the finish workflow, with the binaries of its own run', () => {
    expect(workflow(RELEASE)).toMatch(/^ {4}uses: \.\/\.github\/workflows\/finish-release\.yml$/m);
    expect(workflow(RELEASE)).toMatch(/^ {6}run-id: \$\{\{ github\.run_id \}\}$/m);
  });

  it('creates the GitHub Release, closes the milestone, sets the plugin and updates the tap only in the finish workflow', () => {
    const release = workflow(RELEASE);
    expect(release).not.toContain('gh release create');
    expect(release).not.toContain('milestones/$number" -f state=closed');
    expect(release).not.toContain('--plugin-only');
    expect(release).not.toContain('homebrew-aeolus');
  });
});

describe('the finish workflow', () => {
  it('publishes nothing a release run published before its tag: no npm package, no image, no tag', () => {
    const finish = workflow(FINISH);
    expect(finish).not.toBe('');
    expect(finish).not.toMatch(/npm publish|podman push|git tag|refs\/tags\//);
  });

  it('takes the Go binaries from the named run, not from a build of its own', () => {
    const finish = workflow(FINISH);
    expect(finish).not.toContain('go-binaries.yml');
    expect(finish).toMatch(/^ {10}run-id: \$\{\{ inputs\.run-id \}\}$/m);
  });

  it('finishes only a run of release.yml whose released commit is the tag\'s parent', () => {
    const check = stepNamed(workflow(FINISH), 'Check the run');
    expect(check).toContain('.github/workflows/release.yml');
    expect(check).toMatch(/\^\{commit\}~1|\^\{commit\}\^/);
  });

  it('finishes only binaries attested by release.yml from the released commit', () => {
    const verify = stepNamed(workflow(FINISH), 'Each Go binary');
    expect(verify).toContain('--signer-workflow "$GITHUB_REPOSITORY/.github/workflows/release.yml"');
    expect(verify).toContain('--source-digest');
  });

  it('stops before it changes anything while the release\'s milestone has open issues', () => {
    const check = stepIndex('Check the release\'s milestone has no open issues');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(stepIndex('Create the GitHub Release'));
    expect(stepNamed(workflow(FINISH), 'Check the release\'s milestone has no open issues')).toContain('state=open');
  });

  it('leaves a GitHub Release alone that carries the same SHA256SUMS already', () => {
    const create = stepNamed(workflow(FINISH), 'Create the GitHub Release');
    expect(create).toMatch(/gh release download "v\$VERSION" --pattern SHA256SUMS/);
    expect(create).toMatch(/cmp --silent SHA256SUMS/);
  });

  it('leaves a closed milestone alone', () => {
    const close = stepNamed(workflow(FINISH), 'Close the release');
    expect(close).toMatch(/if \[\[ "\$state" == closed \]\]; then\n +echo "Milestone '\$MILESTONE' is closed already/);
  });

  it('creates the GitHub Release, closes the milestone, sets the plugin on main, then updates the tap', () => {
    const order = ['Create the GitHub Release', 'Close the release', 'Set the aeolus-fleet plugin to', 'Update the Homebrew tap to'].map(stepIndex);
    expect(order[0]).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('the candidate workflow', () => {
  it('builds and checks binaries before packing their integrity with the plugin', () => {
    const candidate = workflow('../.github/workflows/candidate.yml');
    expect(candidate).toContain('uses: ./.github/workflows/go-binaries.yml');
    expect(candidate).toContain('needs: binaries');
    expect(candidate).toContain('pattern: aeolus-trierarch-*');

  });

  it('requires push CI on the same release branch before packing a candidate', () => {
    const gate = stepNamed(workflow('../.github/workflows/candidate.yml'), 'Check the commit');
    expect(gate).toContain('--branch "$GITHUB_REF_NAME" --event push');
    expect(gate).toContain('| node scripts/release-gate.ts "$GITHUB_REF" "$GITHUB_SHA"');
  });

  it('records the plugin and all four binaries with their SHA-512 checksums', () => {
    const folder = mkdtempSync(join(tmpdir(), 'candidate-manifest-'));
    const filenames = ['aeolus-fleet-plugin-0.29.0.tgz', 'aeolus-trierarch-linux-amd64', 'aeolus-trierarch-linux-arm64', 'aeolus-trierarch-darwin-amd64', 'aeolus-trierarch-darwin-arm64'];
    try {
      mkdirSync(join(folder, 'candidate'));
      for (const filename of filenames) {
        writeFileSync(join(folder, 'candidate', filename), '');
      }
      const pack = stepNamed(workflow('../.github/workflows/candidate.yml'), 'Pack the aeolus-fleet plugin');
      const script = /node --input-type=module -e '([\s\S]*?)'/.exec(pack)?.[1] ?? '';
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, VERSION: '0.29.0', RUNNER_TEMP: folder },
      });
      expect(JSON.parse(readFileSync(join(folder, 'candidate', 'integrity.json'), 'utf8'))).toEqual(
        filenames.sort().map((filename) => ({
          name: filename.endsWith('.tgz') ? 'aeolus-fleet-plugin' : filename,
          version: '0.29.0',
          filename,
          integrity: 'sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==',
        })),
      );
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('publishing candidate binaries', () => {
  it('downloads and checks the candidate before preserving its binaries for the finish workflow', () => {
    const release = workflow(RELEASE);
    expect(release).not.toContain('go-binaries.yml');
    expect(stepNamed(release, 'Download the candidate')).toContain('--pattern "aeolus-trierarch-*"');
    expect(stepNamed(release, 'Download the candidate')).toContain('node scripts/candidate-check.ts');
    expect(release).toContain('name: aeolus-trierarch-candidate');
  });
});
