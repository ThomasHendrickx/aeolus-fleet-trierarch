import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PLUGIN_MANIFESTS, PUBLISHED_PACKAGES, setPluginVersion, setVersion } from './set-version.ts';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

// Works on a copy of the real manifests, so the test sees every field the release sees.
let copy: string;

beforeEach(() => {
  copy = mkdtempSync(join(tmpdir(), 'aeolus-set-version-'));
  for (const name of PUBLISHED_PACKAGES) {
    mkdirSync(join(copy, 'packages', name), { recursive: true });
    cpSync(join(repositoryRoot, 'packages', name, 'package.json'), join(copy, 'packages', name, 'package.json'));
  }
  for (const pluginManifest of PLUGIN_MANIFESTS) {
    mkdirSync(join(copy, pluginManifest, '..'), { recursive: true });
    cpSync(join(repositoryRoot, pluginManifest), join(copy, pluginManifest));
  }
});

afterEach(() => {
  rmSync(copy, { recursive: true, force: true });
});

const dependencies = z.record(z.string(), z.string()).optional();
const manifestSchema = z.object({
  version: z.string(),
  repository: z.unknown(),
  bugs: z.unknown(),
  dependencies,
  devDependencies: dependencies,
});

const manifestPath = (name: string) => join(copy, 'packages', name, 'package.json');

function manifest(name: string): z.infer<typeof manifestSchema> {
  return manifestSchema.parse(JSON.parse(readFileSync(manifestPath(name), 'utf8')));
}

function rawManifest(name: string): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(manifestPath(name), 'utf8')));
}

function pluginManifest(path: string): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(join(copy, path), 'utf8')));
}

describe('setVersion', () => {
  it('sets the same version on both aeolus-fleet plugin manifests, keeping their other fields', () => {
    const before = PLUGIN_MANIFESTS.map(pluginManifest);

    setVersion(copy, '0.28.0');

    expect(PLUGIN_MANIFESTS.map(pluginManifest)).toEqual(before.map((manifest) => ({ ...manifest, version: '0.28.0' })));
  });

  it('sets the version on the trierarch, the one package this repository publishes', () => {
    setVersion(copy, '0.28.0');

    expect(PUBLISHED_PACKAGES).toEqual(['trierarch']);
    expect(manifest('trierarch').version).toBe('0.28.0');
  });

  it("keeps the range of another train's package: common and core have versions of their own", () => {
    setVersion(copy, '0.28.0');

    expect(manifest('trierarch').dependencies?.['@aeolus-fleet/common']).toBe('^0.31.0');
    expect(manifest('trierarch').devDependencies?.['@aeolus-fleet/core']).toBe('^0.31.0');
  });

  it("pins a dependency on this repository's own package to that version", () => {
    const withOwnDependency = rawManifest('trierarch');
    writeFileSync(
      manifestPath('trierarch'),
      JSON.stringify({ ...withOwnDependency, devDependencies: { '@aeolus-fleet/trierarch': '0.0.0' } }),
    );

    setVersion(copy, '0.28.0');

    expect(manifest('trierarch').devDependencies).toEqual({ '@aeolus-fleet/trierarch': '0.28.0' });
  });

  it('leaves other dependencies, the repository and bugs alone', () => {
    const before = manifest('trierarch');

    setVersion(copy, '0.28.0');

    const after = manifest('trierarch');
    expect(after.dependencies?.zod).toBe(before.dependencies?.zod);
    expect(after.repository).toEqual(before.repository);
    expect(after.bugs).toEqual(before.bugs);
  });

  it('keeps every field of the manifest in its place', () => {
    const before = Object.keys(rawManifest('trierarch'));

    setVersion(copy, '0.28.0');

    expect(Object.keys(rawManifest('trierarch'))).toEqual(before);
  });

  // The source condition points into src, which the tarball does not ship (aeolus-fleet#968).
  it('removes the @aeolus-fleet/source condition from the exports, keeping types and default', () => {
    setVersion(copy, '0.28.0');

    expect(rawManifest('trierarch').exports).toEqual({
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
    });
  });

  it('accepts a prerelease', () => {
    setVersion(copy, '0.0.0-ci.123');

    expect(manifest('trierarch').version).toBe('0.0.0-ci.123');
  });

  it.each(['', 'v0.1.0', '0.1', '01.0.0', '0.1.0 ', 'latest'])('rejects "%s" and changes nothing', (version) => {
    expect(() => {
      setVersion(copy, version);
    }).toThrow(/Not a semantic version/);
    expect(manifest('trierarch').version).toBe('0.0.0');
  });
});

describe('published manifests', () => {
  // npm trusted publishing fails unless repository.url matches exactly.
  it.each(PUBLISHED_PACKAGES)('%s names this repository and its directory', (name) => {
    const real = manifestSchema.parse(JSON.parse(readFileSync(join(repositoryRoot, 'packages', name, 'package.json'), 'utf8')));

    expect(real.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/ThomasHendrickx/aeolus-fleet-trierarch.git',
      directory: `packages/${name}`,
    });
  });

  // Issues for every train stay in aeolus-fleet.
  it.each(PUBLISHED_PACKAGES)("%s sends its issues to aeolus-fleet's", (name) => {
    const real = manifestSchema.parse(JSON.parse(readFileSync(join(repositoryRoot, 'packages', name, 'package.json'), 'utf8')));

    expect(real.bugs).toEqual({ url: 'https://github.com/ThomasHendrickx/aeolus-fleet/issues' });
  });
});

describe('setPluginVersion', () => {
  it("sets the aeolus-fleet plugin's version alone, leaving the packages as they are", () => {
    const packagesBefore = PUBLISHED_PACKAGES.map((name) => rawManifest(name));

    setPluginVersion(copy, '0.28.0');

    expect(PLUGIN_MANIFESTS.map(pluginManifest)).toEqual([
      expect.objectContaining({ name: 'aeolus-fleet', version: '0.28.0' }),
      expect.objectContaining({ name: 'aeolus-fleet', version: '0.28.0' }),
      expect.objectContaining({ name: 'aeolus-fleet', version: '0.28.0' }),
    ]);
    expect(PUBLISHED_PACKAGES.map((name) => rawManifest(name))).toEqual(packagesBefore);
  });

  it("carries the plugin's Copilot manifest with its Claude Code and Codex ones", () => {
    expect(PLUGIN_MANIFESTS).toContain('plugins/aeolus-fleet/.github/plugin/plugin.json');
  });

  it('refuses a version that is not semantic', () => {
    expect(() => {
      setPluginVersion(copy, 'latest');
    }).toThrow('Not a semantic version: "latest"');
  });
});
