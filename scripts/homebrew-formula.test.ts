import { describe, expect, it } from 'vitest';

import { homebrewFormula } from './homebrew-formula.ts';

const TEMPLATE = [
  'version "@VERSION@"',
  'darwin-arm64 @DARWIN_ARM64_URL@ @DARWIN_ARM64_SHA256@',
  'darwin-amd64 @DARWIN_AMD64_URL@ @DARWIN_AMD64_SHA256@',
  'linux-arm64 @LINUX_ARM64_URL@ @LINUX_ARM64_SHA256@',
  'linux-amd64 @LINUX_AMD64_URL@ @LINUX_AMD64_SHA256@',
].join('\n');

const hash = (digit: string): string => digit.repeat(64);

function sums(...entries: [string, string][]): string {
  return entries.map(([name, digit]) => `${hash(digit)}  ${name}`).join('\n') + '\n';
}

const ALL_SUMS = sums(
  ['aeolus-trierarch-linux-amd64', 'a'],
  ['aeolus-trierarch-linux-arm64', 'b'],
  ['aeolus-trierarch-darwin-arm64', 'c'],
  ['aeolus-trierarch-darwin-amd64', 'd'],
);

describe('the Homebrew formula', () => {
  it('names the release binary and checksum of each system and chip', () => {
    const base = 'https://github.com/acme/trierarch/releases/download/v1.2.3';
    expect(homebrewFormula({ template: TEMPLATE, version: '1.2.3', repository: 'acme/trierarch', sums: ALL_SUMS })).toBe(
      [
        'version "1.2.3"',
        `darwin-arm64 ${base}/aeolus-trierarch-darwin-arm64 ${hash('c')}`,
        `darwin-amd64 ${base}/aeolus-trierarch-darwin-amd64 ${hash('d')}`,
        `linux-arm64 ${base}/aeolus-trierarch-linux-arm64 ${hash('b')}`,
        `linux-amd64 ${base}/aeolus-trierarch-linux-amd64 ${hash('a')}`,
      ].join('\n'),
    );
  });

  it('refuses a release whose SHA256SUMS lacks a binary', () => {
    const missing = sums(['aeolus-trierarch-linux-amd64', 'a'], ['aeolus-trierarch-linux-arm64', 'b'], ['aeolus-trierarch-darwin-arm64', 'c']);
    expect(() => homebrewFormula({ template: TEMPLATE, version: '1.2.3', repository: 'acme/trierarch', sums: missing })).toThrow(
      'SHA256SUMS has no aeolus-trierarch-darwin-amd64',
    );
  });

  it('refuses a checksum that is not 64 hexadecimal digits', () => {
    const bad = ALL_SUMS.replace(hash('c'), 'abc');
    expect(() => homebrewFormula({ template: TEMPLATE, version: '1.2.3', repository: 'acme/trierarch', sums: bad })).toThrow(
      'SHA256SUMS has no aeolus-trierarch-darwin-arm64',
    );
  });

  it('refuses a template placeholder left unfilled', () => {
    expect(() => homebrewFormula({ template: `${TEMPLATE}\n@NEW@`, version: '1.2.3', repository: 'acme/trierarch', sums: ALL_SUMS })).toThrow(
      'The template keeps the placeholder @NEW@',
    );
  });
});
