package attestation

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/testsigstore"
)

// The SLSA provenance GitHub attested for gh 2.103.3's linux amd64 archive, from cli/cli's release workflow, as `gh attestation download` fetched it.
const cliDigest = "4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d"

var cliIdentity = Identity{Issuer: "https://token.actions.githubusercontent.com", Workflow: "https://github.com/cli/cli/.github/workflows/deployment.yml"}

func digestOf(t *testing.T, text string) [32]byte {
	t.Helper()
	raw, err := hex.DecodeString(text)
	if err != nil || len(raw) != 32 {
		t.Fatalf("digest %q: %v", text, err)
	}
	return [32]byte(raw)
}

func cliBundle(t *testing.T) []byte {
	t.Helper()
	bundle, err := os.ReadFile("testdata/cli-provenance.json")
	if err != nil {
		t.Fatal(err)
	}
	return bundle
}

func TestARealGitHubProvenanceVerifiesAgainstSigstoresPublicGoodRoot(t *testing.T) {
	if err := Verify(cliBundle(t), digestOf(t, cliDigest), PublicGood(), cliIdentity); err != nil {
		t.Fatalf("Verify(cli/cli provenance) = %v, want nil", err)
	}
}

func TestAProvenanceOfAnotherArtifactIsRefused(t *testing.T) {
	other := sha256.Sum256([]byte("another file"))
	if err := Verify(cliBundle(t), other, PublicGood(), cliIdentity); !errors.Is(err, ErrUnverified) {
		t.Fatalf("Verify(another digest) = %v, want ErrUnverified", err)
	}
}

func TestAProvenanceSignedByAnotherWorkflowIsRefused(t *testing.T) {
	for _, identity := range []Identity{
		{Issuer: cliIdentity.Issuer, Workflow: "https://github.com/ThomasHendrickx/aeolus-fleet-trierarch/.github/workflows/release.yml"},
		{Issuer: cliIdentity.Issuer, Workflow: "https://github.com/cli/cli/.github/workflows/deployment"},
		{Issuer: "https://accounts.google.com", Workflow: cliIdentity.Workflow},
	} {
		if err := Verify(cliBundle(t), digestOf(t, cliDigest), PublicGood(), identity); !errors.Is(err, ErrUnverified) {
			t.Errorf("Verify(identity %+v) = %v, want ErrUnverified", identity, err)
		}
	}
}

const testWorkflow = "https://github.com/ThomasHendrickx/aeolus-fleet-trierarch/.github/workflows/release.yml"

var testIdentity = Identity{Issuer: "https://token.actions.githubusercontent.com", Workflow: testWorkflow}

type signed struct {
	root   TrustedRoot
	bundle []byte
	digest [32]byte
}

func aSignedArtifact(t *testing.T) signed {
	t.Helper()
	sigstore, err := testsigstore.New()
	if err != nil {
		t.Fatal(err)
	}
	return signedBy(t, sigstore, sigstore)
}

// signedBy is an artifact signed by one Sigstore, with the trusted root of another.
func signedBy(t *testing.T, signer *testsigstore.Sigstore, trusted *testsigstore.Sigstore) signed {
	t.Helper()
	digest := sha256.Sum256([]byte("aeolus-trierarch 0.40.0"))
	bundle, err := signer.Bundle(testsigstore.Signing{Name: "aeolus-trierarch-linux-amd64", Digest: digest[:], Signer: testWorkflow + "@refs/heads/main", Issuer: testIdentity.Issuer, IntegratedTime: time.Now().Add(time.Minute)})
	if err != nil {
		t.Fatal(err)
	}
	text, err := trusted.TrustedRoot()
	if err != nil {
		t.Fatal(err)
	}
	root, err := ParseTrustedRoot(text)
	if err != nil {
		t.Fatal(err)
	}
	return signed{root: root, bundle: bundle, digest: digest}
}

func TestAProvenanceSignedAsTheReleaseWorkflowSignsVerifies(t *testing.T) {
	artifact := aSignedArtifact(t)
	if err := Verify(artifact.bundle, artifact.digest, artifact.root, testIdentity); err != nil {
		t.Fatalf("Verify(signed by the test sigstore) = %v, want nil", err)
	}
}

func TestAProvenanceOfAnAuthorityAndLogNotTrustedIsRefused(t *testing.T) {
	other, err := testsigstore.New()
	if err != nil {
		t.Fatal(err)
	}
	trusted, err := testsigstore.New()
	if err != nil {
		t.Fatal(err)
	}
	artifact := signedBy(t, other, trusted)
	if err := Verify(artifact.bundle, artifact.digest, artifact.root, testIdentity); !errors.Is(err, ErrUnverified) {
		t.Fatalf("Verify(signed by another sigstore) = %v, want ErrUnverified", err)
	}
	if err := Verify(cliBundle(t), digestOf(t, cliDigest), artifact.root, cliIdentity); !errors.Is(err, ErrUnverified) {
		t.Fatalf("Verify(cli/cli against the test root) = %v, want ErrUnverified", err)
	}
}

// changed is the bundle with one field of it changed, by a path of keys and indexes.
func changed(t *testing.T, bundle []byte, change func(map[string]any)) []byte {
	t.Helper()
	var parsed map[string]any
	if err := json.Unmarshal(bundle, &parsed); err != nil {
		t.Fatal(err)
	}
	change(parsed)
	text, err := json.Marshal(parsed)
	if err != nil {
		t.Fatal(err)
	}
	return text
}

func object(value any, keys ...any) map[string]any {
	for _, key := range keys {
		switch k := key.(type) {
		case string:
			value = value.(map[string]any)[k]
		case int:
			value = value.([]any)[k]
		}
	}
	return value.(map[string]any)
}

func TestATamperedBundleIsRefused(t *testing.T) {
	artifact := aSignedArtifact(t)
	other := aSignedArtifact(t)
	var otherBundle map[string]any
	if err := json.Unmarshal(other.bundle, &otherBundle); err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func(map[string]any){
		"the payload": func(b map[string]any) {
			payload, err := base64.StdEncoding.DecodeString(object(b, "dsseEnvelope")["payload"].(string))
			if err != nil {
				t.Fatal(err)
			}
			object(b, "dsseEnvelope")["payload"] = bytes.Replace(payload, []byte("linux-amd64"), []byte("linux-arm64"), 1)
		},
		"the signature": func(b map[string]any) {
			object(b, "dsseEnvelope", "signatures", 0)["sig"] = object(otherBundle, "dsseEnvelope", "signatures", 0)["sig"]
		},
		"the certificate": func(b map[string]any) {
			object(b, "verificationMaterial")["certificate"] = object(otherBundle, "verificationMaterial")["certificate"]
		},
		"the log entry's time": func(b map[string]any) {
			object(b, "verificationMaterial", "tlogEntries", 0)["integratedTime"] = "1700000000"
		},
		"the log entry's body": func(b map[string]any) {
			object(b, "verificationMaterial", "tlogEntries", 0)["canonicalizedBody"] = object(otherBundle, "verificationMaterial", "tlogEntries", 0)["canonicalizedBody"]
		},
		"no log entry": func(b map[string]any) {
			object(b, "verificationMaterial")["tlogEntries"] = []any{}
		},
	} {
		t.Run(name, func(t *testing.T) {
			if err := Verify(changed(t, artifact.bundle, change), artifact.digest, artifact.root, testIdentity); !errors.Is(err, ErrUnverified) {
				t.Fatalf("Verify(%s changed) = %v, want ErrUnverified", name, err)
			}
		})
	}
}

func TestAProvenanceLoggedOutsideItsCertificatesTimeIsRefused(t *testing.T) {
	sigstore, err := testsigstore.New()
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("aeolus-trierarch 0.40.0"))
	// A certificate lives ten minutes from now: a log entry of an hour before is not proof it was used in its time.
	bundle, err := sigstore.Bundle(testsigstore.Signing{Name: "aeolus-trierarch-linux-amd64", Digest: digest[:], Signer: testWorkflow + "@refs/heads/main", Issuer: testIdentity.Issuer, IntegratedTime: time.Now().Add(-time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	text, err := sigstore.TrustedRoot()
	if err != nil {
		t.Fatal(err)
	}
	root, err := ParseTrustedRoot(text)
	if err != nil {
		t.Fatal(err)
	}
	if err := Verify(bundle, digest, root, testIdentity); !errors.Is(err, ErrUnverified) {
		t.Fatalf("Verify(logged an hour before its certificate) = %v, want ErrUnverified", err)
	}
}

func TestAnyOneOfSeveralBundlesThatVerifiesIsEnough(t *testing.T) {
	artifact := aSignedArtifact(t)
	other := aSignedArtifact(t)
	if err := VerifyAny([][]byte{other.bundle, artifact.bundle}, artifact.digest, artifact.root, testIdentity); err != nil {
		t.Fatalf("VerifyAny(one of two verifies) = %v, want nil", err)
	}
	if err := VerifyAny([][]byte{other.bundle}, artifact.digest, artifact.root, testIdentity); !errors.Is(err, ErrUnverified) {
		t.Fatalf("VerifyAny(none verifies) = %v, want ErrUnverified", err)
	}
	if err := VerifyAny(nil, artifact.digest, artifact.root, testIdentity); !errors.Is(err, ErrUnverified) {
		t.Fatalf("VerifyAny(no bundle) = %v, want ErrUnverified", err)
	}
}
