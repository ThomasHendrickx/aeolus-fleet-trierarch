import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isProductionFile, isTestFile, readCommits, tddViolations } from './check-tdd-evidence.ts';
import { createTemporaryRepository, type TemporaryRepository } from './support/temporary-repository.ts';

let repository: TemporaryRepository;
let base: string;

beforeEach(() => {
  repository = createTemporaryRepository();
  repository.write('packages/trierarch/src/core/rules.ts', 'export const fleet = 1;\n');
  repository.write('packages/trierarch/src/core/rules.test.ts', 'test 1\n');
  base = repository.commit('feat(trierarch): fleet');
});

afterEach(() => {
  repository.dispose();
});

function violations(head: string): string[] {
  return tddViolations(readCommits(repository.path, { base, head }));
}

function red(subject = 'test(trierarch): fleet name rule (red)'): string {
  repository.write('packages/trierarch/src/core/rules.test.ts', `test ${subject}\n`);
  return repository.commit(subject);
}

function green(subject = 'feat(trierarch): fleet name rule'): string {
  repository.write('packages/trierarch/src/core/rules.ts', `export const fleet = '${subject}';\n`);
  return repository.commit(subject);
}

describe('the TDD evidence check', () => {
  it('passes a (red) commit followed by the code that makes it pass', () => {
    red();
    const head = green();

    expect(violations(head)).toEqual([]);
  });

  it('passes several red and green pairs', () => {
    red('test(trierarch): first rule (red)');
    green('feat(trierarch): first rule');
    red('test(trierarch): second rule (red)');
    const head = green('feat(trierarch): second rule');

    expect(violations(head)).toEqual([]);
  });

  it('refuses production code without a (red) commit before it, naming commit and files', () => {
    const head = green('feat(trierarch): untested');

    expect(violations(head)).toEqual([
      `${head.slice(0, 12)} "feat(trierarch): untested" changes production code (packages/trierarch/src/core/rules.ts), but the commit before it is not a (red) commit that only adds or changes tests`,
    ]);
  });

  it('refuses when the (red) commit is not directly before the code', () => {
    red();
    repository.write('docs/notes.md', 'notes\n');
    repository.commit('docs: notes');
    const head = green();

    expect(violations(head)).toHaveLength(1);
  });

  it('refuses a second production commit after one (red) commit', () => {
    red();
    green('feat(trierarch): the rule');
    const head = green('feat(trierarch): another rule');

    expect(violations(head)).toEqual([expect.stringContaining('"feat(trierarch): another rule"')]);
  });

  it('refuses the code after a (red) commit that also changes production code', () => {
    repository.write('packages/trierarch/src/core/rules.test.ts', 'test red\n');
    repository.write('packages/trierarch/src/core/supply.ts', 'export const supply = 1;\n');
    repository.commit('test(trierarch): fleet name rule (red)');
    const head = green();

    expect(violations(head)).toEqual([expect.stringContaining('"feat(trierarch): fleet name rule"')]);
  });

  it('refuses a (red) commit that changes anything but tests', () => {
    repository.write('packages/trierarch/src/core/rules.test.ts', 'test red\n');
    repository.write('docs/notes.md', 'notes\n');
    repository.commit('test(trierarch): fleet name rule (red)');
    const head = green();

    expect(violations(head)).toHaveLength(1);
  });

  it('refuses a test commit whose subject does not end in (red)', () => {
    red('test(trierarch): fleet name rule');
    const head = green();

    expect(violations(head)).toHaveLength(1);
  });

  it('refuses a (red) commit that deletes a test', () => {
    repository.remove('packages/trierarch/src/core/rules.test.ts');
    repository.commit('test(trierarch): drop a test (red)');
    const head = green();

    expect(violations(head)).toHaveLength(1);
  });

  it('refuses a fix commit without a (red) commit before it', () => {
    const head = green('fix(trierarch): the fleet name');

    expect(violations(head)).toEqual([expect.stringContaining('"fix(trierarch): the fleet name"')]);
  });

  it('passes a fix commit directly after a (red) commit', () => {
    red();
    const head = green('fix(trierarch): the fleet name');

    expect(violations(head)).toEqual([]);
  });

  it.each(['feat: fleet name', 'feat(trierarch)!: fleet name', 'fix!: fleet name'])(
    'judges %j as a feat or fix commit, with or without a scope or a breaking mark',
    (subject) => {
      const head = green(subject);

      expect(violations(head)).toHaveLength(1);
    },
  );

  it('refuses a feat commit that only deletes production code without a (red) commit', () => {
    repository.remove('packages/trierarch/src/core/rules.ts');
    const head = repository.commit('feat(trierarch): remove fleet');

    expect(violations(head)).toHaveLength(1);
  });

  it.each([
    'refactor(trierarch): tidy the rule',
    'docs(trierarch): say what the fleet is',
    'chore(trierarch): bump',
    'style(trierarch): format',
    'perf(trierarch): faster',
    'test(trierarch): more cases',
    'build: the package',
    'ci: the check',
    'revert: the rule',
  ])('passes %j, which is neither feat nor fix, wherever it comes', (subject) => {
    const head = green(subject);

    expect(violations(head)).toEqual([]);
  });

  it('takes only the type at the start of the subject: feat or fix elsewhere in it does not count', () => {
    const head = green('chore(trierarch): feat(trierarch) and fix the rule');

    expect(violations(head)).toEqual([]);
  });

  it('takes test support in a test folder and end-to-end tests as tests', () => {
    repository.write('packages/trierarch/test/support/in-memory.ts', 'fake\n');
    repository.write('e2e/plugin-session.e2e.test.ts', 'test\n');
    repository.commit('test(trierarch): an in-memory fake (red)');
    const head = green();

    expect(violations(head)).toEqual([]);
  });

  it('judges every file in src, adapters included', () => {
    repository.write('packages/trierarch/src/adapters/rest-fleet.ts', 'export const door = 1;\n');
    const head = repository.commit('feat(trierarch): a door');

    expect(violations(head)).toEqual([
      expect.stringContaining('changes production code (packages/trierarch/src/adapters/rest-fleet.ts)'),
    ]);
  });

  it('does not judge tests, docs, scripts, config or Markdown in src', () => {
    repository.write('packages/trierarch/src/core/rules.test.ts', 'test only\n');
    repository.commit('test(trierarch): more cases');
    repository.write('packages/trierarch/src/core/README.md', '# Network\n');
    repository.write('packages/trierarch/tsconfig.build.json', 'config\n');
    repository.write('scripts/set-version.ts', 'script\n');
    repository.write('docs/blueprint.md', 'blueprint\n');
    const head = repository.commit('docs: many things');

    expect(violations(head)).toEqual([]);
  });

  it('judges only the pull request, not its base', () => {
    const head = repository.commit('chore: nothing');

    expect(violations(head)).toEqual([]);
  });

  it('does not judge merge commits, and a merge is no (red) commit', () => {
    repository.git(['switch', '--quiet', '--create', 'slice']);
    red();
    green();
    repository.git(['switch', '--quiet', 'main']);
    repository.write('packages/trierarch/src/core/supply.ts', 'export const supply = 1;\n');
    const movedBase = repository.commit('feat(trierarch): supply, merged on main meanwhile');
    repository.git(['switch', '--quiet', 'slice']);
    repository.git(['merge', '--quiet', '--no-edit', 'main']);
    const afterMerge = green('feat(trierarch): after the merge');
    // CI passes the base branch as it is now, so what the merge brought in is not the pull request's.
    base = movedBase;

    expect(violations(afterMerge)).toEqual([expect.stringContaining('"feat(trierarch): after the merge"')]);
  });

  it('reads renames with their previous path', () => {
    repository.git(['mv', 'packages/trierarch/src/core/rules.test.ts', 'packages/trierarch/src/core/rules-name.test.ts']);
    repository.commit('test(trierarch): rename the test (red)');
    repository.git(['mv', 'packages/trierarch/src/core/rules.ts', 'packages/trierarch/src/core/rules-name.ts']);
    const head = repository.commit('refactor(trierarch): rename the module');

    const commits = readCommits(repository.path, { base, head });
    expect(commits.map((commit) => commit.files)).toEqual([
      [
        {
          status: 'R100',
          previousPath: 'packages/trierarch/src/core/rules.test.ts',
          path: 'packages/trierarch/src/core/rules-name.test.ts',
        },
      ],
      [
        {
          status: 'R100',
          previousPath: 'packages/trierarch/src/core/rules.ts',
          path: 'packages/trierarch/src/core/rules-name.ts',
        },
      ],
    ]);
    expect(tddViolations(commits)).toEqual([]);
  });
});

describe('what counts as a test and as production code', () => {
  it.each([
    'packages/trierarch/src/core/rules.test.ts',
    'packages/trierarch/src/adapters/tmux.test.ts',
    'packages/trierarch/test/support/in-memory.ts',
    'packages/trierarch/test/trierarch.integration.test.ts',
    'e2e/support/free-port.ts',
  ])('%s is a test file', (path) => {
    expect(isTestFile(path)).toBe(true);
    expect(isProductionFile(path)).toBe(false);
  });

  it.each([
    'packages/trierarch/src/core/rules.ts',
    'packages/trierarch/src/adapters/tmux.ts',
    'packages/trierarch/src/cli/main.ts',
    'packages/trierarch/src/index.ts',
  ])('%s is production code', (path) => {
    expect(isProductionFile(path)).toBe(true);
  });

  it.each(['packages/trierarch/src/core/README.md', 'scripts/set-version.ts', 'packages/trierarch/tsconfig.build.json'])(
    '%s is not judged',
    (path) => {
      expect(isProductionFile(path)).toBe(false);
    },
  );
});
