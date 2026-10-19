import { fileURLToPath } from 'node:url';

import { ESLint, type Linter } from 'eslint';
import { beforeAll } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The first lint types the whole project of the tsconfig, seconds on an idle
 * machine and many more on a loaded one; every lint after it takes a moment.
 */
const PROJECT_TYPING_MS = 180_000;

/** Lints source text as if it were a file at a path in the repository. */
export type Lint = (code: string, path: string) => Promise<Linter.LintMessage[]>;

/**
 * Lints with the repository's real ESLint config, so a test proves the rule
 * that runs in CI. The probe files do not exist on disk, so the only override
 * lets the TypeScript project service type them with the given tsconfig.
 * Fails the test when ESLint cannot parse the code.
 *
 * Create one per test file: typescript-eslint keeps a single project service
 * per process, set up by the first lint, so a second one's probes are unknown.
 * That first lint runs before the file's tests, so each test's time is its
 * rule's alone (#499).
 */
export function createLint(options: { tsconfig: string; probes: readonly string[] }): Lint {
  const eslint = new ESLint({
    cwd: repositoryRoot,
    overrideConfig: {
      languageOptions: {
        parserOptions: {
          projectService: {
            allowDefaultProject: [...options.probes],
            defaultProject: options.tsconfig,
            // Probes are small and made up; typing each one on its own is cheap here.
            maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: options.probes.length,
          },
        },
      },
    },
  });

  const [firstProbe] = options.probes;
  if (firstProbe !== undefined) {
    beforeAll(async () => {
      await eslint.lintText('', { filePath: `${repositoryRoot}${firstProbe}` });
    }, PROJECT_TYPING_MS);
  }

  return async (code, path) => {
    const [result] = await eslint.lintText(code, { filePath: `${repositoryRoot}${path}` });
    const messages = result?.messages ?? [];
    const fatal = messages.find((message) => message.fatal === true);
    if (fatal) {
      throw new Error(`ESLint could not parse the probe: ${fatal.message}`);
    }
    return messages;
  };
}

/** What one rule reported. */
export function reportsOf(messages: readonly Linter.LintMessage[], ruleId: string): string[] {
  return messages.filter((message) => message.ruleId === ruleId).map((message) => message.message);
}
