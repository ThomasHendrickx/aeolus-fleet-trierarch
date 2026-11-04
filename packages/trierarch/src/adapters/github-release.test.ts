import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TrierarchFileError } from './files.js';
import { binaryAssetOf, createGitHubRelease } from './github-release.js';

const REPOSITORY = 'ThomasHendrickx/aeolus-fleet-trierarch';
const ASSET = 'aeolus-trierarch-linux-amd64';
const BINARY = 'the Go trierarch 0.18.0';
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/** What the GitHub of this test answers, by path: a body and its status, 200 when none is given. */
let routes: Map<string, { body: string; status?: number }>;
let server: Server;
let api: string;

beforeEach(async () => {
  server = createServer((request, response) => {
    const route = routes.get(request.url ?? '');
    response.writeHead(route?.status ?? (route === undefined ? 404 : 200));
    response.end(route?.body ?? '{"message":"Not Found"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address: AddressInfo | string | null = server.address();
  api = `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`;
  const assets = [ASSET, 'SHA256SUMS'].map((name) => ({ name, browser_download_url: `${api}/download/${name}` }));
  routes = new Map([
    [`/repos/${REPOSITORY}/releases/tags/v0.18.0`, { body: JSON.stringify({ tag_name: 'v0.18.0', assets }) }],
    [`/download/${ASSET}`, { body: BINARY }],
    ['/download/SHA256SUMS', { body: `${digest('another')}  aeolus-trierarch-darwin-arm64\n${digest(BINARY)}  ${ASSET}\n` }],
    [`/repos/${REPOSITORY}/attestations/sha256:${digest(BINARY)}`, { body: '{"attestations":[{"bundle":{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}}]}' }],
  ]);
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const release = () => createGitHubRelease({ api, repository: REPOSITORY, asset: ASSET, trustedRoot: () => Promise.resolve({}) });

describe("a GitHub Release's binary for this system and chip", () => {
  it.each([
    ['linux', 'x64', 'aeolus-trierarch-linux-amd64'],
    ['linux', 'arm64', 'aeolus-trierarch-linux-arm64'],
    ['darwin', 'arm64', 'aeolus-trierarch-darwin-arm64'],
    ['darwin', 'x64', 'aeolus-trierarch-darwin-amd64'],
  ])('is named for %s on %s as Go names them', (platform, arch, name) => {
    expect(binaryAssetOf(platform, arch)).toBe(name);
  });

  it('is none for a system the release builds no binary for', () => {
    expect(binaryAssetOf('win32', 'x64')).toBeUndefined();
    expect(binaryAssetOf('linux', 'ia32')).toBeUndefined();
  });

  it('is none when there is no such release', async () => {
    expect(await release().binaryOf('0.19.0')).toBeUndefined();
  });

  it.each([ASSET, 'SHA256SUMS'])('is none when the release carries no %s', async (missing) => {
    const assets = [ASSET, 'SHA256SUMS'].filter((name) => name !== missing).map((name) => ({ name, browser_download_url: `${api}/download/${name}` }));
    routes.set(`/repos/${REPOSITORY}/releases/tags/v0.18.0`, { body: JSON.stringify({ tag_name: 'v0.18.0', assets }) });

    expect(await release().binaryOf('0.18.0')).toBeUndefined();
  });

  it('refuses a binary that is not the one SHA256SUMS names', async () => {
    routes.set('/download/SHA256SUMS', { body: `${digest('another binary')}  ${ASSET}\n` });

    await expect(release().binaryOf('0.18.0')).rejects.toThrow(new TrierarchFileError(`${ASSET} of v0.18.0 is sha256:${digest(BINARY)}, but SHA256SUMS names ${digest('another binary')}`));
  });

  it('refuses a binary GitHub keeps no attestation of', async () => {
    routes.delete(`/repos/${REPOSITORY}/attestations/sha256:${digest(BINARY)}`);

    await expect(release().binaryOf('0.18.0')).rejects.toThrow(`${ASSET} of v0.18.0 has no attestation that holds: no attestation of sha256:${digest(BINARY)}`);
  });

  it('refuses a binary whose attestation does not hold', async () => {
    await expect(release().binaryOf('0.18.0')).rejects.toThrow(`${ASSET} of v0.18.0 has no attestation that holds`);
  });

  it('refuses when GitHub does not answer the release, rather than taking npm', async () => {
    routes.set(`/repos/${REPOSITORY}/releases/tags/v0.18.0`, { body: '{"message":"API rate limit exceeded"}', status: 403 });

    await expect(release().binaryOf('0.18.0')).rejects.toThrow(`Could not read the release v0.18.0 of ${REPOSITORY}: ${api}/repos/${REPOSITORY}/releases/tags/v0.18.0 answered 403`);
  });
});
