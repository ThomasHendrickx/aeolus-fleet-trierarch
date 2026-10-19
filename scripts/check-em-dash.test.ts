import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EM_DASH, emDashProblems } from './check-em-dash.ts';
import { createTemporaryRepository, type TemporaryRepository } from './support/temporary-repository.ts';

let repository: TemporaryRepository;
let base: string;

beforeEach(() => {
  repository = createTemporaryRepository();
  repository.write('docs/blueprint.md', `# Blueprint\n\nAn old line ${EM_DASH} from before the rule.\nA plain line.\n`);
  base = repository.commit('docs: blueprint');
});

afterEach(() => {
  repository.dispose();
});

describe('the em dash check', () => {
  it('passes a pull request without em dashes', () => {
    repository.write('docs/blueprint.md', '# Blueprint\n\nAn old line, rewritten.\nA plain line.\n');
    const head = repository.commit('docs: rewrite a line');

    expect(emDashProblems(repository.path, { base, head })).toEqual([]);
  });

  it('refuses an added line with an em dash, naming the file and line', () => {
    repository.write('docs/blueprint.md', `# Blueprint\n\nAn old line ${EM_DASH} from before the rule.\nA plain line ${EM_DASH} now.\n`);
    const head = repository.commit('docs: touch a line');

    expect(emDashProblems(repository.path, { base, head })).toEqual([
      `docs/blueprint.md:4 adds an em dash: A plain line ${EM_DASH} now.`,
    ]);
  });

  it('refuses an em dash in a new file', () => {
    repository.write('packages/trierarch/src/index.ts', `// one ${EM_DASH} two\nexport {};\n`);
    const head = repository.commit('feat: app');

    expect(emDashProblems(repository.path, { base, head })).toEqual([
      expect.stringContaining('packages/trierarch/src/index.ts:1 adds an em dash'),
    ]);
  });

  it('refuses an em dash in a commit message', () => {
    repository.write('docs/notes.md', 'Notes.\n');
    const head = repository.commit(`docs: notes ${EM_DASH} short ones`);

    expect(emDashProblems(repository.path, { base, head })).toEqual([
      expect.stringMatching(/^commit [0-9a-f]{12} has an em dash in its message$/),
    ]);
  });

  it('refuses an em dash in the body of a commit message', () => {
    repository.write('docs/notes.md', 'Notes.\n');
    const head = repository.commit(`docs: notes\n\nWhy ${EM_DASH} because.`);

    expect(emDashProblems(repository.path, { base, head })).toHaveLength(1);
  });

  it('refuses an em dash in a file name', () => {
    repository.write(`docs/a${EM_DASH}b.md`, 'Plain.\n');
    const head = repository.commit('docs: a file');

    expect(emDashProblems(repository.path, { base, head })).toEqual([`docs/a${EM_DASH}b.md has an em dash in its name`]);
  });

  it('lets a pull request remove an em dash', () => {
    repository.write('docs/blueprint.md', '# Blueprint\n\nA plain line.\n');
    const head = repository.commit('docs: drop the old line');

    expect(emDashProblems(repository.path, { base, head })).toEqual([]);
  });

  it('ignores commits and lines that are on the base already', () => {
    const head = repository.commit('chore: nothing');

    expect(emDashProblems(repository.path, { base, head })).toEqual([]);
  });
});
