import { describe, expect, it } from 'vitest';

import { type CandidateRun, candidateRefusal, type PackedTarball } from './candidate-check.ts';

const SHA = '2008806c3eb14be4b6c3fae7fefdfdb9c4969453';
const VERSION = '0.29.0';

function aRun(run: Partial<CandidateRun> = {}): CandidateRun {
  return { workflowName: 'Candidate', conclusion: 'success', headSha: SHA, ...run };
}

function aTarball(name: 'plugin', tarball: Partial<PackedTarball> = {}): PackedTarball {
  return {
    name: `aeolus-fleet-${name}`,
    version: VERSION,
    filename: `aeolus-fleet-${name}-${VERSION}.tgz`,
    integrity: `sha512-${name}`,
    ...tarball,
  };
}

const BINARIES = ['aeolus-trierarch-linux-amd64', 'aeolus-trierarch-linux-arm64', 'aeolus-trierarch-darwin-arm64', 'aeolus-trierarch-darwin-amd64'];
const MANIFEST = [aTarball('plugin'), ...BINARIES.map((name) => ({ name, version: VERSION, filename: name, integrity: `sha512-${name}` }))];
/** What the release computed from the downloaded files, by file name. */
const DOWNLOADED = { 'aeolus-fleet-plugin-0.29.0.tgz': 'sha512-plugin', ...Object.fromEntries(BINARIES.map((name) => [name, `sha512-${name}`])) };

function refusal(check: { run?: CandidateRun; manifest?: PackedTarball[]; downloaded?: Record<string, string> } = {}) {
  return candidateRefusal({ version: VERSION, sha: SHA, run: aRun(), manifest: MANIFEST, downloaded: DOWNLOADED, ...check });
}

describe('the candidate a release publishes', () => {
  it('takes a passed candidate of the released commit at the version asked', () => {
    expect(refusal()).toBeUndefined();
  });

  it('refuses a run of another workflow', () => {
    expect(refusal({ run: aRun({ workflowName: 'CI' }) })).toBe('The run is a CI run, not a Candidate run');
  });

  it('refuses a candidate run that did not pass', () => {
    expect(refusal({ run: aRun({ conclusion: 'failure' }) })).toBe('The Candidate run did not pass (failure)');
  });

  it('refuses a candidate of another commit', () => {
    expect(refusal({ run: aRun({ headSha: 'b'.repeat(40) }) })).toBe(`The candidate is of ${'b'.repeat(40)}, not of the released commit ${SHA}`);
  });

  it('refuses a candidate at another version', () => {
    expect(refusal({ manifest: [aTarball('plugin', { version: '0.28.4' })] })).toBe(
      'The candidate holds aeolus-fleet-plugin 0.28.4, not 0.29.0',
    );
  });

  it('refuses a candidate missing one of the train\'s packages', () => {
    expect(refusal({ manifest: [] })).toBe('The candidate has no aeolus-fleet-plugin');
  });

  it('refuses a manifest that names a different file from the one published', () => {
    expect(refusal({ manifest: [aTarball('plugin', { filename: 'other.tgz' })], downloaded: { 'other.tgz': 'sha512-plugin' } })).toBe(
      'The candidate names other.tgz, not aeolus-fleet-plugin-0.29.0.tgz',
    );
  });

  it('refuses a tarball whose bytes differ from the candidate\'s record', () => {
    expect(refusal({ downloaded: { ...DOWNLOADED, 'aeolus-fleet-plugin-0.29.0.tgz': 'sha512-other' } })).toBe(
      'aeolus-fleet-plugin-0.29.0.tgz is not the file the candidate packed: its integrity differs',
    );
  });

  it('refuses a tarball the download lacks', () => {
    const withoutConsole = {};
    expect(refusal({ downloaded: withoutConsole })).toBe('The download has no aeolus-fleet-plugin-0.29.0.tgz');
  });
});

describe('the candidate binaries a release publishes', () => {
  it.each(BINARIES)('refuses a missing manifest entry for %s', (name) => {
    expect(refusal({ manifest: MANIFEST.filter((file) => file.name !== name) })).toBe(`The candidate has no ${name}`);
  });

  it.each(BINARIES)('refuses changed bytes for %s', (name) => {
    expect(refusal({ downloaded: { ...DOWNLOADED, [name]: 'sha512-changed' } })).toBe(`${name} is not the file the candidate packed: its integrity differs`);
  });

  it.each(BINARIES)('refuses a missing download for %s', (name) => {
    expect(refusal({ downloaded: Object.fromEntries(Object.entries(DOWNLOADED).filter(([filename]) => filename !== name)) })).toBe(`The download has no ${name}`);
  });

  it.each(BINARIES)('refuses a wrong version for %s', (name) => {
    expect(refusal({ manifest: MANIFEST.map((file) => file.name === name ? { ...file, version: '0.28.4' } : file) })).toBe(`The candidate holds ${name} 0.28.4, not ${VERSION}`);
  });

  it.each(BINARIES)('refuses a wrong filename for %s', (name) => {
    expect(refusal({ manifest: MANIFEST.map((file) => file.name === name ? { ...file, filename: 'other' } : file) })).toBe(`The candidate names other, not ${name}`);
  });
});
