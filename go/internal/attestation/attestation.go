// Package attestation checks a GitHub artifact attestation of a file, with
// the standard library only: a Sigstore bundle whose certificate chains to a
// trusted Fulcio authority at the time a trusted Rekor log entered it, whose
// DSSE envelope that certificate signed, whose in-toto statement names the
// file's SHA-256 digest with SLSA provenance, and whose certificate names the
// workflow that signed it and its issuer. upgrade takes a release's binary
// only when it holds (docs/design/trierarch-binary.md).
package attestation

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	_ "embed"
	"encoding/asn1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
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
	authorities []authority
	logs        map[string]transparencyLog
}

type validity struct {
	start time.Time
	end   time.Time
}

func (v validity) holds(at time.Time) bool {
	return !at.Before(v.start) && (v.end.IsZero() || !at.After(v.end))
}

type authority struct {
	chain []*x509.Certificate
	validity
}

type transparencyLog struct {
	key crypto.PublicKey
	validity
}

//go:embed trusted_root.json
var publicGood []byte

// PublicGood is Sigstore's public-good trusted root, which GitHub signs a public repository's attestations with: its Fulcio authorities and its Rekor logs, as `gh attestation trusted-root` gave it.
func PublicGood() TrustedRoot {
	root, err := ParseTrustedRoot(publicGood)
	if err != nil {
		panic(fmt.Sprintf("the embedded trusted root: %v", err))
	}
	return root
}

type validFor struct {
	Start time.Time  `json:"start"`
	End   *time.Time `json:"end"`
}

func (v validFor) validity() validity {
	if v.End == nil {
		return validity{start: v.Start}
	}
	return validity{start: v.Start, end: *v.End}
}

// ParseTrustedRoot reads a Sigstore trusted_root.json.
func ParseTrustedRoot(text []byte) (TrustedRoot, error) {
	var parsed struct {
		Logs []struct {
			PublicKey struct {
				RawBytes []byte   `json:"rawBytes"`
				ValidFor validFor `json:"validFor"`
			} `json:"publicKey"`
			LogID struct {
				KeyID []byte `json:"keyId"`
			} `json:"logId"`
		} `json:"tlogs"`
		Authorities []struct {
			CertChain struct {
				Certificates []struct {
					RawBytes []byte `json:"rawBytes"`
				} `json:"certificates"`
			} `json:"certChain"`
			ValidFor validFor `json:"validFor"`
		} `json:"certificateAuthorities"`
	}
	if err := json.Unmarshal(text, &parsed); err != nil {
		return TrustedRoot{}, fmt.Errorf("read the trusted root: %w", err)
	}
	root := TrustedRoot{logs: map[string]transparencyLog{}}
	for _, log := range parsed.Logs {
		key, err := x509.ParsePKIXPublicKey(log.PublicKey.RawBytes)
		if err != nil {
			return TrustedRoot{}, fmt.Errorf("read the trusted root's log key: %w", err)
		}
		root.logs[hex.EncodeToString(log.LogID.KeyID)] = transparencyLog{key: key, validity: log.PublicKey.ValidFor.validity()}
	}
	for _, entry := range parsed.Authorities {
		var chain []*x509.Certificate
		for _, raw := range entry.CertChain.Certificates {
			certificate, err := x509.ParseCertificate(raw.RawBytes)
			if err != nil {
				return TrustedRoot{}, fmt.Errorf("read the trusted root's authority: %w", err)
			}
			chain = append(chain, certificate)
		}
		if len(chain) > 0 {
			root.authorities = append(root.authorities, authority{chain: chain, validity: entry.ValidFor.validity()})
		}
	}
	return root, nil
}

type bundle struct {
	MediaType            string `json:"mediaType"`
	VerificationMaterial struct {
		Certificate *struct {
			RawBytes []byte `json:"rawBytes"`
		} `json:"certificate"`
		Chain *struct {
			Certificates []struct {
				RawBytes []byte `json:"rawBytes"`
			} `json:"certificates"`
		} `json:"x509CertificateChain"`
		Entries []entry `json:"tlogEntries"`
	} `json:"verificationMaterial"`
	Envelope *struct {
		Payload     []byte `json:"payload"`
		PayloadType string `json:"payloadType"`
		Signatures  []struct {
			Sig []byte `json:"sig"`
		} `json:"signatures"`
	} `json:"dsseEnvelope"`
}

type entry struct {
	LogIndex string `json:"logIndex"`
	LogID    struct {
		KeyID []byte `json:"keyId"`
	} `json:"logId"`
	IntegratedTime   string `json:"integratedTime"`
	InclusionPromise *struct {
		SignedEntryTimestamp []byte `json:"signedEntryTimestamp"`
	} `json:"inclusionPromise"`
	Body []byte `json:"canonicalizedBody"`
}

// The certificate extensions Fulcio writes for a GitHub Actions identity.
var (
	oidIssuerV1 = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 57264, 1, 1}
	oidIssuer   = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 57264, 1, 8}
	oidSigner   = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 57264, 1, 9}
)

const (
	payloadType   = "application/vnd.in-toto+json"
	provenanceV1  = "https://slsa.dev/provenance/v1"
	bundlePrefix  = "application/vnd.dev.sigstore.bundle"
	statementV1   = "https://in-toto.io/Statement/v1"
	statementV01  = "https://in-toto.io/Statement/v0.1"
	sha256Digests = "sha256"
)

func unverified(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrUnverified, fmt.Sprintf(format, args...))
}

// VerifyAny holds when one of the bundles attests the file, as GitHub answers several for one digest.
func VerifyAny(bundles [][]byte, digest [32]byte, root TrustedRoot, identity Identity) error {
	if len(bundles) == 0 {
		return unverified("no attestation of sha256:%s", hex.EncodeToString(digest[:]))
	}
	var reasons []string
	for _, each := range bundles {
		err := Verify(each, digest, root, identity)
		if err == nil {
			return nil
		}
		reasons = append(reasons, strings.TrimPrefix(err.Error(), ErrUnverified.Error()+": "))
	}
	return unverified("%s", strings.Join(reasons, "; "))
}

// Verify holds when the bundle attests the SLSA provenance of the file of that SHA-256 digest, signed by the identity, under the trusted root.
func Verify(text []byte, digest [32]byte, root TrustedRoot, identity Identity) error {
	var parsed bundle
	if err := json.Unmarshal(text, &parsed); err != nil {
		return unverified("read the bundle: %v", err)
	}
	if !strings.HasPrefix(parsed.MediaType, bundlePrefix) {
		return unverified("a bundle of type %q", parsed.MediaType)
	}
	envelope := parsed.Envelope
	if envelope == nil || len(envelope.Signatures) != 1 {
		return unverified("no DSSE envelope with one signature")
	}
	if envelope.PayloadType != payloadType {
		return unverified("a payload of type %q", envelope.PayloadType)
	}
	leaf, err := leafOf(parsed)
	if err != nil {
		return err
	}
	signature := envelope.Signatures[0].Sig
	integrated, err := logged(parsed.VerificationMaterial.Entries, leaf, envelope.Payload, signature, root)
	if err != nil {
		return err
	}
	if err := chains(leaf, integrated, root); err != nil {
		return err
	}
	if !verifies(leaf.PublicKey, pae(envelope.PayloadType, envelope.Payload), signature) {
		return unverified("the envelope's signature is not the certificate's")
	}
	if err := names(leaf, identity); err != nil {
		return err
	}
	return attests(envelope.Payload, digest)
}

func leafOf(parsed bundle) (*x509.Certificate, error) {
	var raw []byte
	material := parsed.VerificationMaterial
	switch {
	case material.Certificate != nil:
		raw = material.Certificate.RawBytes
	case material.Chain != nil && len(material.Chain.Certificates) > 0:
		raw = material.Chain.Certificates[0].RawBytes
	default:
		return nil, unverified("no certificate")
	}
	leaf, err := x509.ParseCertificate(raw)
	if err != nil {
		return nil, unverified("read the certificate: %v", err)
	}
	return leaf, nil
}

// logged is the time a trusted log entered the envelope, as its signed entry timestamp proves: the entry's body names the envelope's payload, its signature and the certificate.
func logged(entries []entry, leaf *x509.Certificate, payload []byte, signature []byte, root TrustedRoot) (time.Time, error) {
	var reasons []string
	for _, each := range entries {
		at, err := loggedBy(each, leaf, payload, signature, root)
		if err == nil {
			return at, nil
		}
		reasons = append(reasons, err.Error())
	}
	if len(reasons) == 0 {
		return time.Time{}, unverified("no transparency log entry")
	}
	return time.Time{}, unverified("%s", strings.Join(reasons, "; "))
}

func loggedBy(each entry, leaf *x509.Certificate, payload []byte, signature []byte, root TrustedRoot) (time.Time, error) {
	logID := hex.EncodeToString(each.LogID.KeyID)
	log, isTrusted := root.logs[logID]
	if !isTrusted {
		return time.Time{}, errors.New("a log entry of a log not trusted")
	}
	if each.InclusionPromise == nil {
		return time.Time{}, errors.New("a log entry with no signed entry timestamp")
	}
	integrated, err := strconv.ParseInt(each.IntegratedTime, 10, 64)
	if err != nil {
		return time.Time{}, fmt.Errorf("a log entry's time %q", each.IntegratedTime)
	}
	index, err := strconv.ParseInt(each.LogIndex, 10, 64)
	if err != nil {
		return time.Time{}, fmt.Errorf("a log entry's index %q", each.LogIndex)
	}
	// Rekor signs the entry as canonical JSON, its keys in order.
	canonical := fmt.Sprintf(`{"body":%q,"integratedTime":%d,"logID":%q,"logIndex":%d}`, base64.StdEncoding.EncodeToString(each.Body), integrated, logID, index)
	if !verifies(log.key, []byte(canonical), each.InclusionPromise.SignedEntryTimestamp) {
		return time.Time{}, errors.New("a log entry its log did not sign")
	}
	at := time.Unix(integrated, 0).UTC()
	if !log.holds(at) {
		return time.Time{}, errors.New("a log entry outside its log's time")
	}
	var body struct {
		Kind string `json:"kind"`
		Spec struct {
			PayloadHash struct {
				Algorithm string `json:"algorithm"`
				Value     string `json:"value"`
			} `json:"payloadHash"`
			Signatures []struct {
				Signature []byte `json:"signature"`
				Verifier  []byte `json:"verifier"`
			} `json:"signatures"`
		} `json:"spec"`
	}
	if err := json.Unmarshal(each.Body, &body); err != nil || body.Kind != "dsse" {
		return time.Time{}, errors.New("a log entry that is no DSSE entry")
	}
	hash := sha256.Sum256(payload)
	if body.Spec.PayloadHash.Algorithm != sha256Digests || body.Spec.PayloadHash.Value != hex.EncodeToString(hash[:]) {
		return time.Time{}, errors.New("a log entry of another payload")
	}
	if len(body.Spec.Signatures) != 1 || !bytes.Equal(body.Spec.Signatures[0].Signature, signature) {
		return time.Time{}, errors.New("a log entry of another signature")
	}
	if verifier, _ := pem.Decode(body.Spec.Signatures[0].Verifier); verifier == nil || !bytes.Equal(verifier.Bytes, leaf.Raw) {
		return time.Time{}, errors.New("a log entry of another certificate")
	}
	return at, nil
}

// chains holds when the certificate chains, for code signing, to an authority of the trusted root at the time it was logged.
func chains(leaf *x509.Certificate, at time.Time, root TrustedRoot) error {
	for _, each := range root.authorities {
		if !each.holds(at) {
			continue
		}
		roots := x509.NewCertPool()
		roots.AddCert(each.chain[len(each.chain)-1])
		intermediates := x509.NewCertPool()
		for _, certificate := range each.chain[:len(each.chain)-1] {
			intermediates.AddCert(certificate)
		}
		if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, Intermediates: intermediates, CurrentTime: at, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageCodeSigning}}); err == nil {
			return nil
		}
	}
	return unverified("the certificate chains to no trusted authority at %s", at.Format(time.RFC3339))
}

// verifies holds when the signature is the key's over the message, with the hash the key's curve takes.
func verifies(key crypto.PublicKey, message []byte, signature []byte) bool {
	switch k := key.(type) {
	case *ecdsa.PublicKey:
		switch k.Curve.Params().BitSize {
		case 384:
			digest := sha512.Sum384(message)
			return ecdsa.VerifyASN1(k, digest[:], signature)
		case 521:
			digest := sha512.Sum512(message)
			return ecdsa.VerifyASN1(k, digest[:], signature)
		default:
			digest := sha256.Sum256(message)
			return ecdsa.VerifyASN1(k, digest[:], signature)
		}
	case ed25519.PublicKey:
		return ed25519.Verify(k, message, signature)
	default:
		return false
	}
}

// pae is DSSE's pre-authentication encoding, what an envelope's signature signs.
func pae(kind string, payload []byte) []byte {
	return []byte(fmt.Sprintf("DSSEv1 %d %s %d %s", len(kind), kind, len(payload), payload))
}

// names holds when the certificate names the issuer, and a signer of the workflow at some ref.
func names(leaf *x509.Certificate, identity Identity) error {
	issuer, signer := "", ""
	for _, extension := range leaf.Extensions {
		switch {
		case extension.Id.Equal(oidIssuer):
			issuer = utf8Of(extension.Value)
		case extension.Id.Equal(oidIssuerV1) && issuer == "":
			issuer = string(extension.Value)
		case extension.Id.Equal(oidSigner):
			signer = utf8Of(extension.Value)
		}
	}
	if issuer != identity.Issuer {
		return unverified("signed under the issuer %q, not %q", issuer, identity.Issuer)
	}
	if !strings.HasPrefix(signer, identity.Workflow+"@") {
		return unverified("signed by %q, not %s", signer, identity.Workflow)
	}
	return nil
}

func utf8Of(der []byte) string {
	var value string
	if _, err := asn1.UnmarshalWithParams(der, &value, "utf8"); err != nil {
		return ""
	}
	return value
}

// attests holds when the statement is SLSA provenance of a subject of the digest.
func attests(payload []byte, digest [32]byte) error {
	var statement struct {
		Type          string `json:"_type"`
		PredicateType string `json:"predicateType"`
		Subject       []struct {
			Digest map[string]string `json:"digest"`
		} `json:"subject"`
	}
	if err := json.Unmarshal(payload, &statement); err != nil {
		return unverified("read the statement: %v", err)
	}
	if statement.Type != statementV1 && statement.Type != statementV01 {
		return unverified("a statement of type %q", statement.Type)
	}
	if statement.PredicateType != provenanceV1 {
		return unverified("a statement of %q, not SLSA provenance", statement.PredicateType)
	}
	want := hex.EncodeToString(digest[:])
	for _, subject := range statement.Subject {
		if strings.EqualFold(subject.Digest[sha256Digests], want) {
			return nil
		}
	}
	return unverified("no subject of sha256:%s", want)
}
