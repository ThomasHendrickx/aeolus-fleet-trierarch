import { describe, expect, it } from 'vitest';

import { createLint, reportsOf } from './support/lint-probe.ts';

// Rules for every package: no type assertions, exhaustive switches, at most
// two parameters, named exports, kebab-case file names, boolean names and no
// module mocks; no vi.fn or vi.spyOn in src/core (typescript and
// test-driven-development skills).

const probes = {
  core: 'packages/trierarch/src/core/rules-probe.ts',
  adapter: 'packages/trierarch/src/adapters/rules-probe.ts',
  test: 'packages/trierarch/src/core/rules-probe.test.ts',
  adapterTest: 'packages/trierarch/src/cli/rules-probe.test.ts',
  script: 'scripts/rules-probe.ts',
  config: 'packages/trierarch/probe.config.ts',
  pascalCase: 'packages/trierarch/src/adapters/RateLimiter.ts',
  snakeCase: 'packages/trierarch/src/adapters/rate_limiter.ts',
  camelCaseTest: 'packages/trierarch/src/adapters/rateLimiter.test.ts',
  kebabCaseTest: 'packages/trierarch/src/adapters/rate-limiter-probe.test.ts',
  setup: 'packages/trierarch/test/postgres-probe.global-setup.ts',
};
// These rules need no package-specific typing, so every probe is typed with the package's tsconfig.
const lint = createLint({ tsconfig: 'packages/trierarch/tsconfig.json', probes: Object.values(probes) });

const everywhere = [probes.core, probes.adapter, probes.script];

describe('type assertions', () => {
  it.each([
    { label: 'as', code: "export const count = JSON.parse('1') as number;" },
    { label: 'angle brackets', code: "export const count = <number>JSON.parse('1');" },
  ])('refuses a cast with $label', async ({ code }) => {
    for (const path of everywhere) {
      expect(reportsOf(await lint(code, path), '@typescript-eslint/consistent-type-assertions')).toHaveLength(1);
    }
  });

  it('allows as const', async () => {
    const code = "export const KINDS = ['operator', 'agent'] as const;";

    expect(reportsOf(await lint(code, probes.core), '@typescript-eslint/consistent-type-assertions')).toEqual([]);
  });
});

describe('switches over a union', () => {
  const switchOver = (cases: string) => `export function label(kind: 'operator' | 'agent'): string {
  switch (kind) {
${cases}
  }
}
`;

  it.each([
    { label: 'misses a member', cases: "    case 'operator':\n      return 'argo';" },
    { label: 'hides a missing member behind default', cases: "    case 'operator':\n      return 'argo';\n    default:\n      return '';" },
  ])('refuses a switch that $label', async ({ cases }) => {
    expect(reportsOf(await lint(switchOver(cases), probes.core), '@typescript-eslint/switch-exhaustiveness-check')).toHaveLength(1);
  });

  it('allows a switch over every member', async () => {
    const code = switchOver("    case 'operator':\n      return 'argo';\n    case 'agent':\n      return 'ship';");

    expect(reportsOf(await lint(code, probes.core), '@typescript-eslint/switch-exhaustiveness-check')).toEqual([]);
  });
});

describe('parameters', () => {
  it.each([
    { label: 'function', code: 'export function end(a: string, b: string, c: string): string {\n  return a + b + c;\n}' },
    { label: 'arrow function', code: 'export const end = (a: string, b: string, c: string) => a + b + c;' },
    { label: 'method', code: 'export const repository = {\n  end(a: string, b: string, c: string) {\n    return a + b + c;\n  },\n};' },
  ])('refuses a $label with three', async ({ code }) => {
    for (const path of [...everywhere, probes.test]) {
      expect(reportsOf(await lint(code, path), '@typescript-eslint/max-params')).toHaveLength(1);
    }
  });

  it('allows two, and one named object', async () => {
    const code = `export const pair = (a: string, b: string) => a + b;
export const named = (end: { fleetId: string; leaseId: string; at: Date }) => end.fleetId;
`;

    expect(reportsOf(await lint(code, probes.core), '@typescript-eslint/max-params')).toEqual([]);
  });
});

describe('default exports', () => {
  it.each([
    { label: 'a function', code: 'export default function ping(): string {\n  return "pong";\n}' },
    { label: 'a value', code: 'const ping = 1;\nexport default ping;' },
    { label: 'a name', code: 'const ping = 1;\nexport { ping as default };' },
  ])('refuses $label as the default export', async ({ code }) => {
    for (const path of [probes.adapter, probes.script, probes.setup]) {
      expect(reportsOf(await lint(code, path), 'no-restricted-exports')).toHaveLength(1);
    }
  });

  it('allows a tool config its default export', async () => {
    const code = 'export default { test: {} };';

    expect(reportsOf(await lint(code, probes.config), 'no-restricted-exports')).toEqual([]);
  });
});

describe('file names', () => {
  it.each([
    { label: 'PascalCase', path: probes.pascalCase },
    { label: 'snake_case', path: probes.snakeCase },
    { label: 'camelCase before .test', path: probes.camelCaseTest },
  ])('refuses a $label file name', async ({ path }) => {
    expect(reportsOf(await lint('export {};', path), 'check-file/filename-naming-convention')).toHaveLength(1);
  });

  it.each([
    { label: 'kebab-case', path: probes.adapter },
    { label: 'kebab-case with .test', path: probes.kebabCaseTest },
    { label: 'kebab-case with a dotted suffix', path: probes.setup },
  ])('allows a $label file name', async ({ path }) => {
    expect(reportsOf(await lint('export {};', path), 'check-file/filename-naming-convention')).toEqual([]);
  });
});

describe('boolean names', () => {
  const rule = '@typescript-eslint/naming-convention';

  it.each([
    { label: 'a variable', code: 'export const ready = true;' },
    { label: 'a parameter', code: 'export const show = (visible: boolean) => (visible ? 1 : 0);' },
    { label: 'an optional property', code: 'export interface Options {\n  secure?: boolean;\n}' },
    { label: 'a class property', code: 'export class Lease {\n  open = true;\n}' },
    { label: 'a name that only starts like a prefix', code: 'export const island = false;' },
  ])('refuses $label without is, has, can, should, was or did', async ({ code }) => {
    for (const path of everywhere) {
      expect(reportsOf(await lint(code, path), rule)).toHaveLength(1);
    }
  });

  it.each(['isReady', 'hasScope', 'canRetire', 'shouldTrustProxy', 'wasSent', 'didClaim'])(
    'allows %s',
    async (name) => {
      expect(reportsOf(await lint(`export const ${name} = true;`, probes.core), rule)).toEqual([]);
    },
  );

  it('checks a destructured name where it is declared, not where it is destructured', async () => {
    const code = 'export function done(result: { ok: boolean }) {\n  const { ok } = result;\n  return ok;\n}';

    expect(reportsOf(await lint(code, probes.adapter), rule)).toEqual([expect.stringContaining('`ok`')]);
  });
});

describe('module mocks', () => {
  it.each(['mock', 'doMock'])('refuses vi.%s', async (name) => {
    const code = `import { vi } from 'vitest';\nvi.${name}('./sign-in.js');`;

    expect(reportsOf(await lint(code, probes.test), 'no-restricted-properties')).toEqual([
      expect.stringContaining('No module mocks: hand-write an in-memory fake'),
    ]);
  });

  it('allows vi.fn in an adapter test', async () => {
    const code = "import { vi } from 'vitest';\nexport const spy = vi.fn();";

    expect(reportsOf(await lint(code, probes.adapterTest), 'no-restricted-properties')).toEqual([]);
  });
});

describe('test doubles in src/core', () => {
  const doubles = [
    { label: 'vi.fn', code: "import { vi } from 'vitest';\nexport const spy = vi.fn();" },
    { label: 'vi.spyOn', code: "import { vi } from 'vitest';\nexport const spy = vi.spyOn(console, 'log');" },
  ];

  it.each(doubles)('refuses $label in src/core, tests and code alike', async ({ code }) => {
    for (const path of [probes.test, probes.core]) {
      expect(reportsOf(await lint(code, path), 'no-restricted-properties')).toEqual([
        expect.stringContaining('No vi.fn or vi.spyOn in src/core'),
      ]);
    }
  });

  it.each(doubles)('allows $label in an adapter test', async ({ code }) => {
    expect(reportsOf(await lint(code, probes.adapterTest), 'no-restricted-properties')).toEqual([]);
  });
});
