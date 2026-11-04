import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { verifyAttestation } from './attestation.js';

// The SLSA provenance GitHub attested for gh 2.103.3's linux amd64 archive, from cli/cli's release workflow, and Sigstore's public-good trusted root, as the Go trierarch's attestation tests read them.
const GO_ATTESTATION = new URL('../../../../go/internal/attestation/', import.meta.url);
const cliBundle: unknown = JSON.parse(readFileSync(new URL('testdata/cli-provenance.json', GO_ATTESTATION), 'utf8'));
const publicGood: unknown = JSON.parse(readFileSync(new URL('trusted_root.json', GO_ATTESTATION), 'utf8'));
const cliDigest = Buffer.from('4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d', 'hex');
const ISSUER = 'https://token.actions.githubusercontent.com';
const cliIdentity = { issuer: ISSUER, workflow: 'https://github.com/cli/cli/.github/workflows/deployment.yml' };

describe('a GitHub artifact attestation, checked with sigstore-js', () => {
  it("holds for a real GitHub provenance under Sigstore's public-good root", () => {
    expect(verifyAttestation({ bundles: [cliBundle], digest: cliDigest, trustedRoot: publicGood, identity: cliIdentity })).toEqual({ isVerified: true });
  });

  it('holds when one of several bundles attests the file', () => {
    expect(verifyAttestation({ bundles: [{ mediaType: 'nonsense' }, cliBundle], digest: cliDigest, trustedRoot: publicGood, identity: cliIdentity })).toEqual({ isVerified: true });
  });

  it('does not hold for another file', () => {
    const other = createHash('sha256').update('another file').digest();

    expect(verifyAttestation({ bundles: [cliBundle], digest: other, trustedRoot: publicGood, identity: cliIdentity })).toMatchObject({ isVerified: false });
  });

  it.each([
    ['another repository', { issuer: ISSUER, workflow: 'https://github.com/ThomasHendrickx/aeolus-fleet-trierarch/.github/workflows/release.yml' }],
    ['a workflow name it only starts with', { issuer: ISSUER, workflow: 'https://github.com/cli/cli/.github/workflows/deployment' }],
    ['another issuer', { issuer: 'https://accounts.google.com', workflow: cliIdentity.workflow }],
  ])('does not hold when signed by %s', (_, identity) => {
    expect(verifyAttestation({ bundles: [cliBundle], digest: cliDigest, trustedRoot: publicGood, identity })).toMatchObject({ isVerified: false });
  });

  it('does not hold under a root that does not trust its signer', () => {
    const empty = { mediaType: 'application/vnd.dev.sigstore.trustedroot+json;version=0.1', tlogs: [], certificateAuthorities: [], ctlogs: [], timestampAuthorities: [] };

    expect(verifyAttestation({ bundles: [cliBundle], digest: cliDigest, trustedRoot: empty, identity: cliIdentity })).toMatchObject({ isVerified: false });
  });

  it('does not hold when there is no attestation, saying so', () => {
    expect(verifyAttestation({ bundles: [], digest: cliDigest, trustedRoot: publicGood, identity: cliIdentity })).toEqual({ isVerified: false, reason: 'no attestation of sha256:4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d' });
  });
});
