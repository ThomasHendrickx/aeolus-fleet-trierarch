// Package testsigstore is a Sigstore of a test's own, sigstore-go's virtual
// one: its trusted root, and attestation bundles it signs as GitHub's artifact
// attestations are signed (a Fulcio certificate naming the workflow and its
// issuer, a DSSE envelope over an in-toto statement of SLSA provenance, a
// Rekor entry with its signed entry timestamp and its inclusion proof, in a
// log of its own whose checkpoint names the tree the proof is of, as sigstore-js
// checks it too). Only tests use it: the Go tests, and the contract suite
// through its command.
package testsigstore

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/cyberphone/json-canonicalization/go/src/webpki.org/jsoncanonicalizer"
	protobundle "github.com/sigstore/protobuf-specs/gen/pb-go/bundle/v1"
	protocommon "github.com/sigstore/protobuf-specs/gen/pb-go/common/v1"
	protodsse "github.com/sigstore/protobuf-specs/gen/pb-go/dsse"
	protorekor "github.com/sigstore/protobuf-specs/gen/pb-go/rekor/v1"
	"github.com/sigstore/rekor/pkg/util"
	"github.com/sigstore/sigstore-go/pkg/bundle"
	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore-go/pkg/testing/ca"
	"github.com/sigstore/sigstore-go/pkg/tlog"
	"github.com/sigstore/sigstore/pkg/signature"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// origin and treeID name the log in its checkpoints, as Rekor names its own (rekor.sigstore.dev - <tree id>).
const (
	origin = "rekor.localhost"
	treeID = 123
)

// Sigstore is a certificate authority and a transparency log, each with its key.
type Sigstore struct {
	virtual *ca.VirtualSigstore
	// log is the transparency log's key: the virtual sigstore's log signs a checkpoint of another tree than its inclusion proof is of.
	log *ecdsa.PrivateKey
}

// New is a Sigstore with keys of its own. Its log is valid for an hour either side of now.
func New() (*Sigstore, error) {
	virtual, err := ca.NewVirtualSigstore()
	if err != nil {
		return nil, err
	}
	log, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	return &Sigstore{virtual: virtual, log: log}, nil
}

// logID is the log's id: the SHA-256 digest of its PKIX public key.
func (s *Sigstore) logID() ([]byte, error) {
	der, err := x509.MarshalPKIXPublicKey(s.log.Public())
	if err != nil {
		return nil, err
	}
	id := sha256.Sum256(der)
	return id[:], nil
}

// TrustedRoot is the Sigstore's trusted_root.json, in the shape Sigstore publishes its own.
func (s *Sigstore) TrustedRoot() ([]byte, error) {
	id, err := s.logID()
	if err != nil {
		return nil, err
	}
	logs := map[string]*root.TransparencyLog{hex.EncodeToString(id): {
		BaseURL:             "https://" + origin,
		ID:                  id,
		ValidityPeriodStart: time.Now().Add(-time.Hour),
		ValidityPeriodEnd:   time.Now().Add(time.Hour),
		HashFunc:            crypto.SHA256,
		PublicKey:           s.log.Public(),
		SignatureHashFunc:   crypto.SHA256,
	}}
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

// promised is the entry as this Sigstore's log enters it, the only entry of its tree: its kind, the log's signed entry timestamp, and its inclusion proof with the checkpoint of that tree.
func (s *Sigstore) promised(entry *protorekor.TransparencyLogEntry) (*protorekor.TransparencyLogEntry, error) {
	kept, isEntry := proto.Clone(entry).(*protorekor.TransparencyLogEntry)
	if !isEntry {
		return nil, errors.New("the virtual sigstore's log entry is no entry")
	}
	id, err := s.logID()
	if err != nil {
		return nil, err
	}
	signer, err := signature.LoadECDSASignerVerifier(s.log, crypto.SHA256)
	if err != nil {
		return nil, err
	}
	payload, err := json.Marshal(tlog.RekorPayload{Body: base64.StdEncoding.EncodeToString(kept.CanonicalizedBody), IntegratedTime: kept.IntegratedTime, LogIndex: 0, LogID: hex.EncodeToString(id)})
	if err != nil {
		return nil, err
	}
	canonical, err := jsoncanonicalizer.Transform(payload)
	if err != nil {
		return nil, err
	}
	timestamp, err := signer.SignMessage(bytes.NewReader(canonical))
	if err != nil {
		return nil, err
	}
	// A tree of one leaf: its root is the leaf's hash, and its proof holds no hashes.
	leaf := sha256.Sum256(append([]byte{0}, kept.CanonicalizedBody...))
	checkpoint, err := util.CreateAndSignCheckpoint(context.Background(), origin, treeID, 1, leaf[:], signer)
	if err != nil {
		return nil, err
	}
	kept.LogIndex = 0
	kept.LogId = &protocommon.LogId{KeyId: id}
	kept.KindVersion = &protorekor.KindVersion{Kind: "dsse", Version: "0.0.1"}
	kept.InclusionPromise = &protorekor.InclusionPromise{SignedEntryTimestamp: timestamp}
	kept.InclusionProof = &protorekor.InclusionProof{LogIndex: 0, RootHash: leaf[:], TreeSize: 1, Checkpoint: &protorekor.Checkpoint{Envelope: string(checkpoint)}}
	return kept, nil
}

func decodeBase64(text string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(text)
}
