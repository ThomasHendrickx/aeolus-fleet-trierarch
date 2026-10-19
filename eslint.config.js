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

/** @typedef {{ regex: string, message: string }} ImportRestriction */
/** @typedef {{ selector: string, message: string }} SyntaxRestriction */
/** @typedef {{ object: string, property: string, message: string }} PropertyRestriction */

/**
 * What src/core must never import (CLAUDE.md, "Architecture rules"). It
 * includes Prisma and pg, so the core needs no other list for them.
 * @type {ImportRestriction[]}
 */
const coreForbiddenImports = [
  { what: 'Prisma', regex: '^(prisma|prisma/.+|@prisma/.+|\\.prisma/.+)$' },
  { what: 'pg', regex: '^pg([-/].+)?$' },
  { what: 'Fastify', regex: '^(fastify|fastify/.+|fastify-.+|@fastify/.+)$' },
  { what: 'tRPC', regex: '^@trpc/.+$' },
  { what: 'an adapter', regex: '(^|/)adapters(/|$)' },
  { what: 'Aeolus core, which it reaches only through its fleet adapter', regex: '^@aeolus-fleet/core(/.+)?$' },
].map(({ what, regex }) => ({
  regex,
  message: `src/core must not import ${what}. The core holds domain, use cases and ports; adapters depend on it, never the other way round.`,
}));

const clockMessage = 'src/core never reads the clock: take `now` from the Clock port or as input.';
const cryptoMessage = 'src/core never uses crypto: hashing and random tokens are ports.';

/** The core is deterministic and never throws (domain-modelling and typescript skills). */
const coreImpure = {
  /** @type {ImportRestriction[]} */
  imports: [{ regex: '^(node:)?crypto$', message: cryptoMessage }],
  /** @type {SyntaxRestriction[]} */
  syntax: [
    { selector: 'NewExpression[callee.name="Date"][arguments.length=0]', message: clockMessage },
    { selector: 'CallExpression[callee.name="Date"]', message: clockMessage },
    {
      selector: 'ThrowStatement',
      message: 'src/core never throws: return a Result with a domain error kind. Only adapters throw, for system failures.',
    },
  ],
  /** @type {PropertyRestriction[]} */
  properties: [
    { object: 'Date', property: 'now', message: clockMessage },
    { object: 'Math', property: 'random', message: 'src/core never makes randomness: take it from a port.' },
    { object: 'globalThis', property: 'crypto', message: cryptoMessage },
  ],
  globals: [{ name: 'crypto', message: cryptoMessage }],
};

/** @type {PropertyRestriction[]} */
const noModuleMocks = ['mock', 'doMock'].map((property) => ({
  object: 'vi',
  property,
  message: 'No module mocks: hand-write an in-memory fake of the port and assert outcomes (test-driven-development skill).',
}));

/**
 * The core is tested with hand-written in-memory fakes, asserting outcomes and
 * stored state, not calls. Adapters (I/O) may use them.
 * @type {PropertyRestriction[]}
 */
const noTestDoubles = ['fn', 'spyOn'].map((property) => ({
  object: 'vi',
  property,
  message:
    'No vi.fn or vi.spyOn in src/core: hand-write an in-memory fake and assert outcomes and stored state, not calls (test-driven-development skill).',
}));

// esquery regex literals cannot contain a slash, so write it as \x2F.
const esqueryRegex = (/** @type {string} */ regex) => `/${regex.replaceAll('/', '\\x2F')}/`;

/**
 * no-restricted-imports does not see import() expressions or import('x') types,
 * so each import restriction is also a syntax restriction.
 * @param {ImportRestriction[]} restrictions
 * @returns {SyntaxRestriction[]}
 */
function dynamicImports(restrictions) {
  return restrictions.flatMap(({ regex, message }) => [
    { selector: `ImportExpression[source.value=${esqueryRegex(regex)}]`, message },
    { selector: `TSImportType[source.value=${esqueryRegex(regex)}]`, message },
  ]);
}

/**
 * Every import restriction for a set of files, static and dynamic, plus any
 * other syntax restriction for the same files.
 * @param {{ patterns: ImportRestriction[], syntax?: SyntaxRestriction[] }} restrictions
 */
function importRules({ patterns, syntax = [] }) {
  return {
    'no-restricted-imports': [
      'error',
      { patterns: patterns.map(({ regex, message }) => ({ regex, caseSensitive: true, message })) },
    ],
    'no-restricted-syntax': ['error', ...dynamicImports(patterns), ...syntax],
  };
}

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

  {
    // Its core holds no framework or adapter, reads no clock and never throws.
    name: 'aeolus/trierarch-core',
    files: ['packages/trierarch/src/core/**/*.ts'],
    rules: {
      ...importRules({ patterns: [...coreForbiddenImports, ...coreImpure.imports], syntax: coreImpure.syntax }),
      'no-restricted-properties': ['error', ...noModuleMocks, ...noTestDoubles, ...coreImpure.properties],
      'no-restricted-globals': ['error', ...coreImpure.globals],
    },
  },
);
