import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useCaseFactories, useCaseTestProblems } from './check-use-case-tests.ts';
import { createTemporaryRepository, type TemporaryRepository } from './support/temporary-repository.ts';

const signIn = 'export function createSignIn(deps: Deps): SignIn {\n  return () => deps.run();\n}\n';

describe('recognising a use-case file', () => {
  it.each([
    { label: 'an exported factory function', source: signIn, factories: ['createSignIn'] },
    { label: 'an exported async factory function', source: 'export async function createPing() {}\n', factories: ['createPing'] },
    {
      label: 'an exported factory constant',
      source: 'export const createListFleets = (deps: Deps) => () => deps.list();\n',
      factories: ['createListFleets'],
    },
  ])('recognises $label', ({ source, factories }) => {
    expect(useCaseFactories(source)).toEqual(factories);
  });

  it.each([
    ['a value object', 'export function fleetName(raw: string) { return raw.trim(); }\n'],
    ['a factory that is not exported', 'function createSignIn() {}\nexport const x = 1;\n'],
    ['a re-export of a factory', "export { createSignIn } from './sign-in.js';\n"],
    ['a word that only starts with create', 'export function created() {}\nexport function creates() {}\n'],
    ['a type', 'export type createSignIn = () => void;\n'],
  ])('does not take %s for a use case', (_label, source) => {
    expect(useCaseFactories(source)).toEqual([]);
  });
});

describe('the use-case test check', () => {
  let repository: TemporaryRepository;

  beforeEach(() => {
    repository = createTemporaryRepository();
  });

  afterEach(() => {
    repository.dispose();
  });

  it('passes a use case with its test beside it', () => {
    repository.write('packages/trierarch/src/core/sign-in.ts', signIn);
    repository.write('packages/trierarch/src/core/sign-in.test.ts', 'test\n');
    repository.commit('feat: sign in');

    expect(useCaseTestProblems(repository.path)).toEqual([]);
  });

  it('refuses a use case without a test', () => {
    repository.write('packages/trierarch/src/core/sign-in.ts', signIn);
    repository.commit('feat: sign in');

    expect(useCaseTestProblems(repository.path)).toEqual([
      'packages/trierarch/src/core/sign-in.ts is a use case (createSignIn) without packages/trierarch/src/core/sign-in.test.ts',
    ]);
  });

  it('refuses a use case whose test is elsewhere', () => {
    repository.write('packages/trierarch/src/core/sign-in.ts', signIn);
    repository.write('packages/trierarch/test/sign-in.test.ts', 'test\n');
    repository.commit('feat: sign in');

    expect(useCaseTestProblems(repository.path)).toHaveLength(1);
  });

  it('looks only at the core', () => {
    repository.write('packages/trierarch/src/adapters/json-state.ts', 'export function createJsonState() {}\n');
    repository.write('packages/trierarch/src/core/rule-limits.ts', 'export function fleetName() {}\n');
    repository.commit('feat: adapters and value objects');

    expect(useCaseTestProblems(repository.path)).toEqual([]);
  });
});
