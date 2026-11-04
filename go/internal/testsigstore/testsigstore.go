// Package testsigstore is a Sigstore of a test's own: a certificate authority
// and a transparency log key, its trusted root, and attestation bundles it
// signs as GitHub's artifact attestations are signed (a Fulcio certificate
// naming the workflow, a DSSE envelope over an in-toto statement, a Rekor
// entry with its signed entry timestamp). Only tests use it: the Go tests,
// and the contract suite through its command.
package testsigstore

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net/url"
	"strconv"
	"time"
)

// Sigstore is a certificate authority and a transparency log, each with its key.
type Sigstore struct {
	authority    *x509.Certificate
	authorityKey *ecdsa.PrivateKey
	logKey       *ecdsa.PrivateKey
}

// New is a Sigstore with keys of its own, its authority valid from a day before now for a year.
func New() (*Sigstore, error) {
	authorityKey, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if err != nil {
		return nil, err
	}
	logKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{Organization: []string{"test"}, CommonName: "test sigstore"},
		NotBefore:             time.Now().Add(-24 * time.Hour),
		NotAfter:              time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageCodeSigning},
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &authorityKey.PublicKey, authorityKey)
	if err != nil {
		return nil, err
	}
	authority, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	return &Sigstore{authority: authority, authorityKey: authorityKey, logKey: logKey}, nil
}

func (s *Sigstore) logID() ([]byte, error) {
	der, err := x509.MarshalPKIXPublicKey(&s.logKey.PublicKey)
	if err != nil {
		return nil, err
	}
	id := sha256.Sum256(der)
	return id[:], nil
}

// TrustedRoot is the Sigstore's trusted_root.json, in the shape Sigstore publishes its own.
func (s *Sigstore) TrustedRoot() ([]byte, error) {
	logKey, err := x509.MarshalPKIXPublicKey(&s.logKey.PublicKey)
	if err != nil {
		return nil, err
	}
	logID, err := s.logID()
	if err != nil {
		return nil, err
	}
	start := s.authority.NotBefore.UTC().Format(time.RFC3339)
	return json.Marshal(map[string]any{
		"mediaType": "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
		"tlogs": []any{map[string]any{
			"baseUrl":       "https://rekor.test",
			"hashAlgorithm": "SHA2_256",
			"publicKey":     map[string]any{"rawBytes": logKey, "keyDetails": "PKIX_ECDSA_P256_SHA_256", "validFor": map[string]string{"start": start}},
			"logId":         map[string]any{"keyId": logID},
		}},
		"certificateAuthorities": []any{map[string]any{
			"subject":   map[string]string{"organization": "test", "commonName": "test sigstore"},
			"uri":       "https://fulcio.test",
			"certChain": map[string]any{"certificates": []any{map[string]any{"rawBytes": s.authority.Raw}}},
			"validFor":  map[string]string{"start": start},
		}},
	})
}

// Signing is what a bundle attests: the artifact by its name and SHA-256 digest, signed by the workflow (a build signer URI, such as https://github.com/<repository>/.github/workflows/release.yml@refs/heads/main) under the issuer, entered in the log at a time.
type Signing struct {
	Name           string
	Digest         []byte
	Signer         string
	Issuer         string
	IntegratedTime time.Time
}

var (
	oidIssuer     = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 57264, 1, 8}
	oidSigner     = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 57264, 1, 9}
	oidRepository = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 57264, 1, 12}
)

func utf8Extension(id asn1.ObjectIdentifier, value string) (pkix.Extension, error) {
	der, err := asn1.MarshalWithParams(value, "utf8")
	return pkix.Extension{Id: id, Value: der}, err
}

// Bundle is a Sigstore bundle (v0.3) attesting the SLSA provenance of the artifact, as GitHub's attest-build-provenance writes it.
func (s *Sigstore) Bundle(signing Signing) ([]byte, error) {
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	signer, err := url.Parse(signing.Signer)
	if err != nil {
		return nil, err
	}
	var extensions []pkix.Extension
	for _, extension := range []struct {
		id    asn1.ObjectIdentifier
		value string
	}{{oidIssuer, signing.Issuer}, {oidSigner, signing.Signer}, {oidRepository, signer.Scheme + "://" + signer.Host}} {
		made, err := utf8Extension(extension.id, extension.value)
		if err != nil {
			return nil, err
		}
		extensions = append(extensions, made)
	}
	template := &x509.Certificate{
		SerialNumber:    big.NewInt(signing.IntegratedTime.UnixNano()),
		NotBefore:       signing.IntegratedTime.Add(-time.Minute),
		NotAfter:        signing.IntegratedTime.Add(9 * time.Minute),
		KeyUsage:        x509.KeyUsageDigitalSignature,
		ExtKeyUsage:     []x509.ExtKeyUsage{x509.ExtKeyUsageCodeSigning},
		URIs:            []*url.URL{signer},
		ExtraExtensions: extensions,
	}
	leaf, err := x509.CreateCertificate(rand.Reader, template, s.authority, &leafKey.PublicKey, s.authorityKey)
	if err != nil {
		return nil, err
	}
	statement, err := json.Marshal(map[string]any{
		"_type":         "https://in-toto.io/Statement/v1",
		"subject":       []any{map[string]any{"name": signing.Name, "digest": map[string]string{"sha256": hex.EncodeToString(signing.Digest)}}},
		"predicateType": "https://slsa.dev/provenance/v1",
		"predicate":     map[string]any{},
	})
	if err != nil {
		return nil, err
	}
	const payloadType = "application/vnd.in-toto+json"
	signature, err := signed(leafKey, PAE(payloadType, statement))
	if err != nil {
		return nil, err
	}
	payloadHash := sha256.Sum256(statement)
	body, err := json.Marshal(map[string]any{
		"apiVersion": "0.0.1",
		"kind":       "dsse",
		"spec": map[string]any{
			"payloadHash": map[string]string{"algorithm": "sha256", "value": hex.EncodeToString(payloadHash[:])},
			"signatures":  []any{map[string]any{"signature": signature, "verifier": pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leaf})}},
		},
	})
	if err != nil {
		return nil, err
	}
	entry, err := s.logEntry(body, signing.IntegratedTime)
	if err != nil {
		return nil, err
	}
	return json.Marshal(bundle{
		MediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
		VerificationMaterial: material{
			Certificate: map[string]any{"rawBytes": leaf},
			Entries:     []any{entry},
		},
		Envelope: map[string]any{
			"payload":     statement,
			"payloadType": payloadType,
			"signatures":  []any{map[string]any{"sig": signature}},
		},
	})
}

type bundle struct {
	MediaType            string   `json:"mediaType"`
	VerificationMaterial material `json:"verificationMaterial"`
	Envelope             any      `json:"dsseEnvelope"`
}

type material struct {
	Certificate any   `json:"certificate"`
	Entries     []any `json:"tlogEntries"`
}

// logEntry is the log's entry of the body, integrated at the time, with its signed entry timestamp.
func (s *Sigstore) logEntry(body []byte, at time.Time) (map[string]any, error) {
	logID, err := s.logID()
	if err != nil {
		return nil, err
	}
	const logIndex = 7
	integrated := at.Unix()
	canonical := fmt.Sprintf(`{"body":%q,"integratedTime":%d,"logID":%q,"logIndex":%d}`, base64.StdEncoding.EncodeToString(body), integrated, hex.EncodeToString(logID), logIndex)
	entryTimestamp, err := signed(s.logKey, []byte(canonical))
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"logIndex":          strconv.Itoa(logIndex),
		"logId":             map[string]any{"keyId": logID},
		"kindVersion":       map[string]string{"kind": "dsse", "version": "0.0.1"},
		"integratedTime":    strconv.FormatInt(integrated, 10),
		"inclusionPromise":  map[string]any{"signedEntryTimestamp": entryTimestamp},
		"canonicalizedBody": body,
	}, nil
}

// BundleLoggedAt is a bundle this Sigstore signed, its log entry made again at another time, its signed entry timestamp valid.
func (s *Sigstore) BundleLoggedAt(signedBundle []byte, at time.Time) ([]byte, error) {
	var parsed struct {
		MediaType            string `json:"mediaType"`
		VerificationMaterial struct {
			Certificate json.RawMessage `json:"certificate"`
			Entries     []struct {
				Body []byte `json:"canonicalizedBody"`
			} `json:"tlogEntries"`
		} `json:"verificationMaterial"`
		Envelope json.RawMessage `json:"dsseEnvelope"`
	}
	if err := json.Unmarshal(signedBundle, &parsed); err != nil {
		return nil, err
	}
	if len(parsed.VerificationMaterial.Entries) != 1 {
		return nil, fmt.Errorf("bundle has %d log entries, want 1", len(parsed.VerificationMaterial.Entries))
	}
	entry, err := s.logEntry(parsed.VerificationMaterial.Entries[0].Body, at)
	if err != nil {
		return nil, err
	}
	return json.Marshal(bundle{MediaType: parsed.MediaType, VerificationMaterial: material{Certificate: parsed.VerificationMaterial.Certificate, Entries: []any{entry}}, Envelope: parsed.Envelope})
}

// PAE is DSSE's pre-authentication encoding of a payload, what its signature signs.
func PAE(payloadType string, payload []byte) []byte {
	return []byte(fmt.Sprintf("DSSEv1 %d %s %d %s", len(payloadType), payloadType, len(payload), payload))
}

func signed(key *ecdsa.PrivateKey, message []byte) ([]byte, error) {
	digest := sha256.Sum256(message)
	return ecdsa.SignASN1(rand.Reader, key, digest[:])
}
