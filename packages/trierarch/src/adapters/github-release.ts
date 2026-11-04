/**
 * The GitHub Release v<version> of this repository, as upgrade reads it for
 * the Go trierarch (#142): its binary for the machine's system and chip
 * (aeolus-trierarch-<goos>-<goarch>), taken only when SHA256SUMS of the
 * release names its digest and a GitHub artifact attestation, signed by the
 * repository's release workflow, holds for it, as the Go trierarch's own
 * upgrade takes it (go/internal/release). A release that carries no such
 * binary is none: upgrade takes npm then.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { TrustedRoot } from '@sigstore/protobuf-specs';
import { getTrustedRoot } from '@sigstore/tuf';
import { z } from 'zod';

import { verifyAttestation } from './attestation.js';
import { TrierarchFileError } from './files.js';

export const GITHUB_API = 'https://api.github.com';
export const REPOSITORY = 'ThomasHendrickx/aeolus-fleet-trierarch';
const ISSUER = 'https://token.actions.githubusercontent.com';

/** The systems and chips the release builds a binary for, as Go names them. */
const GO_SYSTEMS: Readonly<Record<string, string>> = { linux: 'linux', darwin: 'darwin' };
const GO_CHIPS: Readonly<Record<string, string>> = { x64: 'amd64', arm64: 'arm64' };

/** The binary's asset name for Node's platform and arch; none for one the release builds no binary for. */
export function binaryAssetOf(platform: string, arch: string): string | undefined {
  const system = GO_SYSTEMS[platform];
  const chip = GO_CHIPS[arch];
  return system === undefined || chip === undefined ? undefined : `aeolus-trierarch-${system}-${chip}`;
}

/** The Sigstore trusted root an attestation is checked against: the trusted_root.json the file names, or Sigstore's public-good root through its TUF repository, as sigstore-js keeps it. */
export async function sigstoreTrustedRoot(file: string | undefined): Promise<unknown> {
  if (file !== undefined) {
    return JSON.parse(await readFile(file, 'utf8'));
  }
  return TrustedRoot.toJSON(await getTrustedRoot());
}

const releaseSchema = z.object({ assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })) });
const attestationsSchema = z.object({ attestations: z.array(z.object({ bundle: z.unknown() })) });

/** GitHub answered nothing there: no such release, or no attestation. */
class NotFound extends Error {}

async function read(url: string): Promise<Buffer> {
  const answer = await fetch(url, { headers: { accept: 'application/vnd.github+json' } });
  if (answer.status === 404) {
    throw new NotFound(url);
  }
  if (!answer.ok) {
    throw new Error(`${url} answered ${String(answer.status)}`);
  }
  return Buffer.from(await answer.arrayBuffer());
}

async function readJson(url: string): Promise<unknown> {
  return JSON.parse((await read(url)).toString('utf8'));
}

/** The checksum SHA256SUMS (sha256sum's lines, `<hex>  <name>`, a binary's name after a `*`) names for the file. */
function checksumOf(sums: string, name: string): string | undefined {
  for (const line of sums.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length === 2 && fields[1]?.replace(/^\*/, '') === name) {
      return fields[0]?.toLowerCase();
    }
  }
  return undefined;
}

export interface GitHubRelease {
  /** The binary of the version, once its checksum and attestation hold; none when the release carries none for this system and chip. Refuses with a TrierarchFileError otherwise. */
  binaryOf(version: string): Promise<Buffer | undefined>;
}

export function createGitHubRelease(at: {
  api: string;
  repository: string;
  /** The binary's asset name for this system and chip. */
  asset: string;
  /** The Sigstore trusted root, as trusted_root.json holds it. */
  trustedRoot: () => Promise<unknown>;
}): GitHubRelease {
  const { api, repository, asset } = at;
  return {
    binaryOf: async (version) => {
      const tag = `v${version}`;
      let release: z.infer<typeof releaseSchema>;
      try {
        release = releaseSchema.parse(await readJson(`${api}/repos/${repository}/releases/tags/${tag}`));
      } catch (error) {
        if (error instanceof NotFound) {
          return undefined;
        }
        throw new TrierarchFileError(`Could not read the release ${tag} of ${repository}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const urls = new Map(release.assets.map((each) => [each.name, each.browser_download_url]));
      const binaryUrl = urls.get(asset);
      const sumsUrl = urls.get('SHA256SUMS');
      if (binaryUrl === undefined || sumsUrl === undefined) {
        return undefined;
      }
      const downloaded = await Promise.all([read(binaryUrl), read(sumsUrl)]).catch((error: unknown) => {
        throw new TrierarchFileError(`Could not download ${asset} of ${tag} with its SHA256SUMS: ${error instanceof Error ? error.message : String(error)}`);
      });
      const [binary, sums] = downloaded;
      const digest = createHash('sha256').update(binary).digest();
      const named = checksumOf(sums.toString('utf8'), asset);
      if (named !== digest.toString('hex')) {
        throw new TrierarchFileError(`${asset} of ${tag} is sha256:${digest.toString('hex')}, but SHA256SUMS names ${named ?? 'no checksum of it'}`);
      }
      let bundles: unknown[];
      try {
        bundles = attestationsSchema.parse(await readJson(`${api}/repos/${repository}/attestations/sha256:${digest.toString('hex')}`)).attestations.map((each) => each.bundle).filter((bundle) => bundle !== undefined && bundle !== null);
      } catch (error) {
        if (!(error instanceof NotFound)) {
          throw new TrierarchFileError(`Could not read the attestations of ${asset} of ${tag}: ${error instanceof Error ? error.message : String(error)}`);
        }
        bundles = [];
      }
      const outcome = verifyAttestation({ bundles, digest, trustedRoot: await at.trustedRoot(), identity: { issuer: ISSUER, workflow: `https://github.com/${repository}/.github/workflows/release.yml` } });
      if (!outcome.isVerified) {
        throw new TrierarchFileError(`${asset} of ${tag} has no attestation that holds: ${outcome.reason}`);
      }
      return binary;
    },
  };
}
