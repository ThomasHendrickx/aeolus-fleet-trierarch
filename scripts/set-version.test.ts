import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PLUGIN_MANIFESTS, setPluginVersion, setPluginVersionUnlessNewer, setVersion } from './set-version.ts';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

// Works on a copy of the real manifests, so the test sees every field the release sees.
let copy: string;

beforeEach(() => {
  copy = mkdtempSync(join(tmpdir(), 'aeolus-set-version-'));
  for (const pluginManifest of PLUGIN_MANIFESTS) {
    mkdirSync(join(copy, pluginManifest, '..'), { recursive: true });
    cpSync(join(repositoryRoot, pluginManifest), join(copy, pluginManifest));
  }
});

afterEach(() => {
  rmSync(copy, { recursive: true, force: true });
});

function pluginManifest(path: string): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(join(copy, path), 'utf8')));
}

describe('setVersion', () => {
  it('releases the Cursor manifest with the other harness manifests', () => {
    expect(PLUGIN_MANIFESTS).toContain('plugins/aeolus-fleet/.cursor-plugin/plugin.json');
  });

  it('sets the same version on every aeolus-fleet plugin manifest, keeping their other fields', () => {
    const before = PLUGIN_MANIFESTS.map(pluginManifest);

    setVersion(copy, '0.28.0');

    expect(PLUGIN_MANIFESTS.map(pluginManifest)).toEqual(before.map((manifest) => ({ ...manifest, version: '0.28.0' })));
  });

  it('accepts a prerelease for the session image build', () => {
    setVersion(copy, '0.0.0-ci.123');
    expect(PLUGIN_MANIFESTS.map((path) => pluginManifest(path).version)).toEqual(['0.0.0-ci.123', '0.0.0-ci.123', '0.0.0-ci.123', '0.0.0-ci.123']);
  });

  it.each(['', 'v0.1.0', '0.1', '01.0.0', '0.1.0 ', 'latest'])('rejects "%s" and changes nothing', (version) => {
    const before = PLUGIN_MANIFESTS.map(pluginManifest);
    expect(() => {
      setVersion(copy, version);
    }).toThrow(/Not a semantic version/);
    expect(PLUGIN_MANIFESTS.map(pluginManifest)).toEqual(before);
  });

});

describe('setPluginVersion', () => {
  it("sets the aeolus-fleet plugin's version", () => {
    setPluginVersion(copy, '0.28.0');

    expect(PLUGIN_MANIFESTS.map(pluginManifest)).toEqual([
      expect.objectContaining({ name: 'aeolus-fleet', version: '0.28.0' }),
      expect.objectContaining({ name: 'aeolus-fleet', version: '0.28.0' }),
      expect.objectContaining({ name: 'aeolus-fleet', version: '0.28.0' }),
      expect.objectContaining({ name: 'aeolus-fleet', version: '0.28.0' }),
    ]);
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

describe('setPluginVersionUnlessNewer', () => {
  it("sets the plugin to the release's version from any release, a hotfix branch's included, when the plugin is older", () => {
    setPluginVersion(copy, '0.36.0');

    setPluginVersionUnlessNewer(copy, '0.36.1');

    expect(PLUGIN_MANIFESTS.map((path) => pluginManifest(path).version)).toEqual(['0.36.1', '0.36.1', '0.36.1', '0.36.1']);
  });

  it('compares versions by number, not by text: 0.36.10 is newer than 0.36.9', () => {
    setPluginVersion(copy, '0.36.9');

    setPluginVersionUnlessNewer(copy, '0.36.10');

    expect(PLUGIN_MANIFESTS.map((path) => pluginManifest(path).version)).toEqual(['0.36.10', '0.36.10', '0.36.10', '0.36.10']);
  });

  it("leaves a plugin that is newer alone: a hotfix of an older line never takes main's plugin back", () => {
    setPluginVersion(copy, '0.37.0');

    setPluginVersionUnlessNewer(copy, '0.36.2');

    expect(PLUGIN_MANIFESTS.map((path) => pluginManifest(path).version)).toEqual(['0.37.0', '0.37.0', '0.37.0', '0.37.0']);
  });

  it('refuses a version that is not semantic', () => {
    expect(() => {
      setPluginVersionUnlessNewer(copy, 'latest');
    }).toThrow('Not a semantic version: "latest"');
  });
});
