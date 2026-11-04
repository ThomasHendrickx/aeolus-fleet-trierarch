import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ReleaseBuild } from './build-global-setup.js';

const REPOSITORY = 'ThomasHendrickx/aeolus-fleet-trierarch';

/** The binary's asset name for this machine, as Go names its system and chip. */
const ASSET = `aeolus-trierarch-linux-${process.arch === 'x64' ? 'amd64' : process.arch}`;

/**
 * A GitHub of the suite's own, as upgrade reads a release from it: the
 * release v<version> with the binary for this machine and SHA256SUMS, and the
 * binary's attestation, signed by a Sigstore of a test's own as the release
 * workflow signs. `env` points a trierarch at it
 * (AEOLUS_TRIERARCH_RELEASES_URL, AEOLUS_TRIERARCH_TRUSTED_ROOT).
 */
export interface ReleaseSource {
  readonly version: string;
  /** The binary the release carries. */
  readonly binary: Buffer;
  readonly env: Readonly<Record<string, string>>;
  close(): Promise<void>;
}

/** What is wrong with the release: its checksum names another binary, or its attestation is signed by a Sigstore the trierarch does not trust. */
export type Fault = 'bad checksum' | 'bad attestation';

/** A binary that answers as the trierarch of the version does, but whose `run` starts no trierarch: a release that fails to start. */
export function aBinaryThatDoesNotStart(version: string): Buffer {
  return Buffer.from(`#!/bin/sh
case "$1" in
  --version) echo '{"version":"${version}"}' ;;
  config) echo '{"path":"config.json"}' ;;
  upgrade) echo '{"from":"${version}","to":"${version}","isUpgraded":false,"isPluginUpdated":true,"said":[]}' ;;
  run) echo 'this trierarch starts no trierarch' >&2; exit 1 ;;
esac
`);
}

function listening(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address: AddressInfo | string | null = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
}

export async function aReleaseSource(build: ReleaseBuild, at: { binary?: Buffer; fault?: Fault } = {}): Promise<ReleaseSource> {
  const folder = mkdtempSync(join(tmpdir(), 'trierarch-contract-github-'));
  const binary = at.binary ?? readFileSync(build.binary);
  writeFileSync(join(folder, ASSET), binary, { mode: 0o755 });
  execFileSync(build.signer, [folder, join(folder, ASSET)]);
  const bundle = readFileSync(join(folder, `${ASSET}.bundle.json`), 'utf8');
  if (at.fault === 'bad attestation') {
    // Signed as the release workflow signs, by a Sigstore the trierarch is not told to trust.
    const other = mkdtempSync(join(tmpdir(), 'trierarch-contract-other-sigstore-'));
    execFileSync(build.signer, [other]);
    copyFileSync(join(other, 'trusted_root.json'), join(folder, 'trusted_root.json'));
    rmSync(other, { recursive: true, force: true });
  }
  const digest = createHash('sha256').update(binary).digest('hex');
  const named = at.fault === 'bad checksum' ? createHash('sha256').update('another binary').digest('hex') : digest;
  const sums = `${named}  ${ASSET}\n`;
  const tag = `v${build.version}`;
  let base = '';
  interface Answer {
    readonly body: string | Buffer;
    readonly type: string;
  }
  const json = (body: string): Answer => ({ body, type: 'application/json' });
  const routes = (): ReadonlyMap<string, Answer> =>
    new Map<string, Answer>([
      [`/repos/${REPOSITORY}/releases/latest`, json(JSON.stringify({ tag_name: tag }))],
      [`/repos/${REPOSITORY}/releases/tags/${tag}`, json(JSON.stringify({ tag_name: tag, assets: [ASSET, 'SHA256SUMS'].map((name) => ({ name, browser_download_url: `${base}/download/${name}` })) }))],
      [`/download/${ASSET}`, { body: binary, type: 'application/octet-stream' }],
      ['/download/SHA256SUMS', { body: sums, type: 'text/plain' }],
      [`/repos/${REPOSITORY}/attestations/sha256:${digest}`, json(`{"attestations":[{"bundle":${bundle}}]}`)],
    ]);
  const server = createServer((request, response) => {
    const route = routes().get(request.url ?? '');
    response.writeHead(route === undefined ? 404 : 200, { 'content-type': route?.type ?? 'application/json' });
    response.end(route?.body ?? JSON.stringify({ message: 'Not Found' }));
  });
  base = `http://127.0.0.1:${String(await listening(server))}`;
  return {
    version: build.version,
    binary,
    env: { AEOLUS_TRIERARCH_RELEASES_URL: base, AEOLUS_TRIERARCH_TRUSTED_ROOT: join(folder, 'trusted_root.json') },
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
