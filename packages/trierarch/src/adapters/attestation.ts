/**
 * A GitHub artifact attestation of a file, checked with sigstore-js: a Sigstore
 * bundle of SLSA provenance of the file's SHA-256 digest, its certificate
 * chained to a trusted Fulcio authority at the time a trusted Rekor log entered
 * it, naming the workflow that signed it and its issuer, as the Go trierarch
 * checks it (go/internal/attestation). upgrade takes a release's binary only
 * when it holds (#142).
 */
import { bundleFromJSON } from '@sigstore/bundle';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import { toSignedEntity, toTrustMaterial, Verifier } from '@sigstore/verify';
import { z } from 'zod';

/** Who must have signed: the OIDC issuer, and the workflow's URI without its ref (https://github.com/<owner>/<repo>/.github/workflows/<file>). */
export interface SignerIdentity {
  readonly issuer: string;
  readonly workflow: string;
}

export type AttestationOutcome = { readonly isVerified: true } | { readonly isVerified: false; readonly reason: string };

const IN_TOTO_PAYLOAD = 'application/vnd.in-toto+json';
const PROVENANCE_V1 = 'https://slsa.dev/provenance/v1';

const statementSchema = z.object({
  predicateType: z.string(),
  subject: z.array(z.object({ digest: z.record(z.string(), z.string()) })),
});

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Holds when the bundle attests the SLSA provenance of the file of that digest, signed by the identity, under the trusted root. */
function verifyOne(json: unknown, at: { digest: Buffer; verifier: Verifier; identity: SignerIdentity }): AttestationOutcome {
  const { digest, verifier, identity } = at;
  try {
    const bundle = bundleFromJSON(json);
    // The workflow at any ref: a release is dispatched from main or a hotfix branch.
    verifier.verify(toSignedEntity(bundle), { subjectAlternativeName: new RegExp(`^${escaped(identity.workflow)}@`), extensions: { issuer: identity.issuer } });
    if (bundle.content.$case !== 'dsseEnvelope' || bundle.content.dsseEnvelope.payloadType !== IN_TOTO_PAYLOAD) {
      return { isVerified: false, reason: 'no in-toto statement' };
    }
    const statement = statementSchema.safeParse(JSON.parse(bundle.content.dsseEnvelope.payload.toString('utf8')));
    if (!statement.success || statement.data.predicateType !== PROVENANCE_V1) {
      return { isVerified: false, reason: 'no SLSA provenance' };
    }
    const hex = digest.toString('hex');
    if (!statement.data.subject.some((subject) => subject.digest.sha256?.toLowerCase() === hex)) {
      return { isVerified: false, reason: `it attests no file of sha256:${hex}` };
    }
    return { isVerified: true };
  } catch (error) {
    return { isVerified: false, reason: reasonOf(error) };
  }
}

/** Holds when one of the bundles attests the file, as GitHub answers several for one digest. */
export function verifyAttestation(at: { bundles: readonly unknown[]; digest: Buffer; trustedRoot: unknown; identity: SignerIdentity }): AttestationOutcome {
  if (at.bundles.length === 0) {
    return { isVerified: false, reason: `no attestation of sha256:${at.digest.toString('hex')}` };
  }
  let verifier: Verifier;
  try {
    // The log's integrated time is the time the certificate is checked at, as the Go trierarch checks it: GitHub's public-good attestations carry no other timestamp, nor certificate transparency it checks.
    verifier = new Verifier(toTrustMaterial(TrustedRoot.fromJSON(at.trustedRoot)), { tlogThreshold: 1, ctlogThreshold: 0, timestampThreshold: 1 });
  } catch (error) {
    return { isVerified: false, reason: `the trusted root: ${reasonOf(error)}` };
  }
  const reasons: string[] = [];
  for (const bundle of at.bundles) {
    const outcome = verifyOne(bundle, { digest: at.digest, verifier, identity: at.identity });
    if (outcome.isVerified) {
      return outcome;
    }
    reasons.push(outcome.reason);
  }
  return { isVerified: false, reason: reasons.join('; ') };
}
