// Package attestation checks a GitHub artifact attestation of a file with
// sigstore-go: a Sigstore bundle of SLSA provenance of the file's SHA-256
// digest, its certificate chained to a trusted Fulcio authority at the time a
// trusted Rekor log entered it, and naming the workflow that signed it and its
// issuer. upgrade takes a release's binary only when it holds
// (docs/design/trierarch-binary.md).
package attestation

import (
	_ "embed"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/sigstore/sigstore-go/pkg/bundle"
	"github.com/sigstore/sigstore-go/pkg/fulcio/certificate"
	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore-go/pkg/verify"
)

// ErrUnverified is every reason a bundle does not attest the file: wrapped with the reason.
var ErrUnverified = errors.New("the attestation does not hold")

// Identity is who must have signed: the OIDC issuer, and the workflow's URI without its ref (https://github.com/<owner>/<repo>/.github/workflows/<file>).
type Identity struct {
	Issuer   string
	Workflow string
}

// TrustedRoot is the Fulcio authorities and Rekor logs a bundle is checked against.
type TrustedRoot struct {
	material root.TrustedMaterial
}

//go:embed trusted_root.json
var publicGood []byte

// PublicGood is Sigstore's public-good trusted root, which GitHub signs a public repository's attestations with, as `gh attestation trusted-root` gave it.
func PublicGood() TrustedRoot {
	trusted, err := ParseTrustedRoot(publicGood)
	if err != nil {
		panic(fmt.Sprintf("the embedded trusted root: %v", err))
	}
	return trusted
}

// ParseTrustedRoot reads a Sigstore trusted_root.json.
func ParseTrustedRoot(text []byte) (TrustedRoot, error) {
	trusted, err := root.NewTrustedRootFromJSON(text)
	if err != nil {
		return TrustedRoot{}, fmt.Errorf("read the trusted root: %w", err)
	}
	return TrustedRoot{material: trusted}, nil
}

const provenanceV1 = "https://slsa.dev/provenance/v1"

func unverified(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrUnverified, fmt.Sprintf(format, args...))
}

// VerifyAny holds when one of the bundles attests the file, as GitHub answers several for one digest.
func VerifyAny(bundles [][]byte, digest [32]byte, trusted TrustedRoot, identity Identity) error {
	if len(bundles) == 0 {
		return unverified("no attestation of sha256:%s", hex.EncodeToString(digest[:]))
	}
	var reasons []string
	for _, each := range bundles {
		err := Verify(each, digest, trusted, identity)
		if err == nil {
			return nil
		}
		reasons = append(reasons, strings.TrimPrefix(err.Error(), ErrUnverified.Error()+": "))
	}
	return unverified("%s", strings.Join(reasons, "; "))
}

// Verify holds when the bundle attests the SLSA provenance of the file of that SHA-256 digest, signed by the identity, under the trusted root.
func Verify(text []byte, digest [32]byte, trusted TrustedRoot, identity Identity) error {
	if trusted.material == nil {
		return unverified("no trusted root")
	}
	var parsed bundle.Bundle
	if err := parsed.UnmarshalJSON(text); err != nil {
		return unverified("read the bundle: %v", err)
	}
	// The log's integrated time is the time the certificate is checked at: GitHub's public-good attestations carry no other timestamp.
	verifier, err := verify.NewVerifier(trusted.material, verify.WithTransparencyLog(1), verify.WithIntegratedTimestamps(1))
	if err != nil {
		return unverified("%v", err)
	}
	signer, err := verify.NewSANMatcher("", "^"+regexp.QuoteMeta(identity.Workflow)+"@")
	if err != nil {
		return unverified("%v", err)
	}
	issuer, err := verify.NewIssuerMatcher(identity.Issuer, "")
	if err != nil {
		return unverified("%v", err)
	}
	signedBy, err := verify.NewCertificateIdentity(signer, issuer, certificate.Extensions{})
	if err != nil {
		return unverified("%v", err)
	}
	result, err := verifier.Verify(&parsed, verify.NewPolicy(verify.WithArtifactDigest("sha256", digest[:]), verify.WithCertificateIdentity(signedBy)))
	if err != nil {
		return unverified("%v", err)
	}
	if result.Statement == nil || result.Statement.PredicateType != provenanceV1 {
		return unverified("no SLSA provenance")
	}
	return nil
}
