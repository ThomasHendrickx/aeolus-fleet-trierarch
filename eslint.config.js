// @ts-check
import js from '@eslint/js';
import checkFile from 'eslint-plugin-check-file';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

/*
 * The guardrails: what CLAUDE.md and the skills ask for, enforced here so it
 * never depends on an agent remembering. Each rule is proven by a test in
 * lint/ that fails when the rule is removed.
 *
 * Several guardrails use the same ESLint rule (no-restricted-imports and its
 * siblings) on overlapping files, and ESLint keeps only the last options it
 * finds for a rule. So the restrictions are lists, and every block below
 * passes the complete set for its files.
 */

/** @typedef {{ object: string, property: string, message: string }} PropertyRestriction */

/** @type {PropertyRestriction[]} */
const noModuleMocks = ['mock', 'doMock'].map((property) => ({
  object: 'vi',
  property,
  message: 'No module mocks: hand-write an in-memory fake of the port and assert outcomes (test-driven-development skill).',
}));

export default defineConfig(
  globalIgnores(['**/node_modules/', '**/dist/', '**/coverage/']),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  {
    name: 'aeolus/all-packages',
    plugins: { 'check-file': checkFile },
    rules: {
      'max-params': 'off',
      '@typescript-eslint/max-params': ['error', { max: 2 }],
      'no-restricted-exports': [
        'error',
        { restrictDefaultExports: { direct: true, named: true, defaultFrom: true, namedFrom: true, namespaceFrom: true } },
      ],
      // Dotted suffixes such as .test and .global-setup are not checked.
      'check-file/filename-naming-convention': [
        'error',
        { '**/*.{js,ts}': 'KEBAB_CASE' },
        { ignoreMiddleExtensions: true },
      ],
      'no-restricted-properties': ['error', ...noModuleMocks],
    },
  },
  {
    name: 'aeolus/all-packages-typed',
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/naming-convention': [
        'error',
        // A destructured name is its source's name, checked where that is declared.
        { selector: ['variable', 'parameter'], modifiers: ['destructured'], types: ['boolean'], format: null },
        {
          selector: ['variable', 'parameter', 'classProperty', 'parameterProperty', 'typeProperty', 'accessor'],
          types: ['boolean'],
          format: ['PascalCase'],
          prefix: ['is', 'has', 'can', 'should', 'was', 'did'],
        },
      ],
    },
  },
  {
    // Tools read their config files' default export.
    name: 'aeolus/default-export-required',
    files: ['**/*.config.{js,ts}'],
    rules: { 'no-restricted-exports': 'off' },
  },

);
