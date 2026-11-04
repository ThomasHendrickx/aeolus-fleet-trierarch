// Package testsigstore is a Sigstore of a test's own, sigstore-go's virtual
// one: its trusted root, and attestation bundles it signs as GitHub's artifact
// attestations are signed (a Fulcio certificate naming the workflow and its
// issuer, a DSSE envelope over an in-toto statement of SLSA provenance, a
// Rekor entry with its signed entry timestamp). Only tests use it: the Go
// tests, and the contract suite through its command.
package testsigstore

import (
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	protobundle "github.com/sigstore/protobuf-specs/gen/pb-go/bundle/v1"
	protocommon "github.com/sigstore/protobuf-specs/gen/pb-go/common/v1"
	protodsse "github.com/sigstore/protobuf-specs/gen/pb-go/dsse"
	protorekor "github.com/sigstore/protobuf-specs/gen/pb-go/rekor/v1"
	"github.com/sigstore/sigstore-go/pkg/bundle"
	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore-go/pkg/testing/ca"
	"github.com/sigstore/sigstore-go/pkg/tlog"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// Sigstore is a certificate authority and a transparency log, each with its key.
type Sigstore struct {
	virtual *ca.VirtualSigstore
}

// New is a Sigstore with keys of its own. Its log is valid for an hour either side of now.
func New() (*Sigstore, error) {
	virtual, err := ca.NewVirtualSigstore()
	if err != nil {
		return nil, err
	}
	return &Sigstore{virtual: virtual}, nil
}

// TrustedRoot is the Sigstore's trusted_root.json, in the shape Sigstore publishes its own.
func (s *Sigstore) TrustedRoot() ([]byte, error) {
	logs := map[string]*root.TransparencyLog{}
	for _, log := range s.virtual.RekorLogs() {
		der, err := x509.MarshalPKIXPublicKey(log.PublicKey)
		if err != nil {
			return nil, err
		}
		id := sha256.Sum256(der)
		kept := *log
		kept.ID = id[:]
		logs[hex.EncodeToString(id[:])] = &kept
	}
	trusted, err := root.NewTrustedRoot(root.TrustedRootMediaType01, s.virtual.FulcioCertificateAuthorities(), nil, nil, logs)
	if err != nil {
		return nil, err
	}
	return trusted.MarshalJSON()
}

// Signing is what a bundle attests: the artifact by its name and SHA-256 digest, signed by the workflow (its URI with a ref, such as https://github.com/<repository>/.github/workflows/release.yml@refs/heads/main) under the issuer, entered in the log at a time within ten minutes after now, when the certificate is valid.
type Signing struct {
	Name           string
	Digest         []byte
	Signer         string
	Issuer         string
	IntegratedTime time.Time
}

// Bundle is a Sigstore bundle (v0.3) attesting the SLSA provenance of the artifact, as GitHub's attest-build-provenance writes it.
func (s *Sigstore) Bundle(signing Signing) ([]byte, error) {
	statement, err := json.Marshal(map[string]any{
		"_type":         "https://in-toto.io/Statement/v1",
		"subject":       []any{map[string]any{"name": signing.Name, "digest": map[string]string{"sha256": hex.EncodeToString(signing.Digest)}}},
		"predicateType": "https://slsa.dev/provenance/v1",
		"predicate":     map[string]any{},
	})
	if err != nil {
		return nil, err
	}
	entity, err := s.virtual.AttestAtTime(signing.Signer, signing.Issuer, statement, signing.IntegratedTime, true)
	if err != nil {
		return nil, err
	}
	content, err := entity.VerificationContent()
	if err != nil {
		return nil, err
	}
	certificate, isCertificate := content.(*bundle.Certificate)
	if !isCertificate {
		return nil, errors.New("the virtual sigstore signed with no certificate")
	}
	signature, err := entity.SignatureContent()
	if err != nil {
		return nil, err
	}
	envelope, isEnvelope := signature.(*bundle.Envelope)
	if !isEnvelope {
		return nil, errors.New("the virtual sigstore signed no envelope")
	}
	var signatures []*protodsse.Signature
	for _, each := range envelope.Signatures {
		raw, err := decodeBase64(each.Sig)
		if err != nil {
			return nil, err
		}
		signatures = append(signatures, &protodsse.Signature{Sig: raw, Keyid: each.KeyID})
	}
	payload, err := decodeBase64(envelope.Payload)
	if err != nil {
		return nil, err
	}
	entries, err := entity.TlogEntries()
	if err != nil {
		return nil, err
	}
	var logEntries []*protorekor.TransparencyLogEntry
	for _, entry := range entries {
		logEntry, err := s.promised(entry.TransparencyLogEntry())
		if err != nil {
			return nil, err
		}
		logEntries = append(logEntries, logEntry)
	}
	made := &protobundle.Bundle{
		MediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
		VerificationMaterial: &protobundle.VerificationMaterial{
			Content:     &protobundle.VerificationMaterial_Certificate{Certificate: &protocommon.X509Certificate{RawBytes: certificate.Certificate().Raw}},
			TlogEntries: logEntries,
		},
		Content: &protobundle.Bundle_DsseEnvelope{DsseEnvelope: &protodsse.Envelope{Payload: payload, PayloadType: envelope.PayloadType, Signatures: signatures}},
	}
	return protojson.Marshal(made)
}

// promised is the log's entry as a bundle holds it: its kind, and the log's signed entry timestamp, which the virtual sigstore keeps apart.
func (s *Sigstore) promised(entry *protorekor.TransparencyLogEntry) (*protorekor.TransparencyLogEntry, error) {
	kept, isEntry := proto.Clone(entry).(*protorekor.TransparencyLogEntry)
	if !isEntry {
		return nil, errors.New("the virtual sigstore's log entry is no entry")
	}
	timestamp, err := s.virtual.RekorSignPayload(tlog.RekorPayload{Body: base64.StdEncoding.EncodeToString(kept.CanonicalizedBody), IntegratedTime: kept.IntegratedTime, LogIndex: kept.LogIndex, LogID: hex.EncodeToString(kept.LogId.KeyId)})
	if err != nil {
		return nil, err
	}
	kept.KindVersion = &protorekor.KindVersion{Kind: "dsse", Version: "0.0.1"}
	kept.InclusionPromise = &protorekor.InclusionPromise{SignedEntryTimestamp: timestamp}
	return kept, nil
}

func decodeBase64(text string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(text)
}
