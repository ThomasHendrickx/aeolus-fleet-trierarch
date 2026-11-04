package release

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/attestation"
	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/testsigstore"
)

const repository = "ThomasHendrickx/aeolus-fleet-trierarch"

// aRelease is a GitHub of a test's own: the release v<version> with the binary for linux amd64, its SHA256SUMS and its attestation, as the release workflow would publish them.
type aRelease struct {
	version     string
	binary      []byte
	sums        string
	bundles     [][]byte
	isCompacted bool
	latest      string
}

func (r *aRelease) serve(t *testing.T) *httptest.Server {
	t.Helper()
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		asset := func(name string) map[string]string {
			return map[string]string{"name": name, "browser_download_url": server.URL + "/download/" + name}
		}
		digest := sha256.Sum256(r.binary)
		switch request.URL.Path {
		case "/repos/" + repository + "/releases/latest":
			_ = json.NewEncoder(w).Encode(map[string]string{"tag_name": "v" + r.latest})
		case "/repos/" + repository + "/releases/tags/v" + r.version:
			_ = json.NewEncoder(w).Encode(map[string]any{"tag_name": "v" + r.version, "assets": []any{asset("aeolus-trierarch-linux-amd64"), asset("SHA256SUMS")}})
		case "/download/aeolus-trierarch-linux-amd64":
			_, _ = w.Write(r.binary)
		case "/download/SHA256SUMS":
			_, _ = w.Write([]byte(r.sums))
		case "/repos/" + repository + "/attestations/sha256:" + hex.EncodeToString(digest[:]):
			var attestations []any
			for index, bundle := range r.bundles {
				if r.isCompacted {
					attestations = append(attestations, map[string]any{"bundle": nil, "bundle_url": fmt.Sprintf("%s/bundle/%d", server.URL, index)})
				} else {
					attestations = append(attestations, map[string]any{"bundle": json.RawMessage(bundle)})
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"attestations": attestations})
		case "/bundle/0":
			_, _ = w.Write(compacted(r.bundles[0]))
		default:
			http.NotFound(w, request)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

// compacted is a bundle as GitHub stores it behind bundle_url: Snappy's block format, all of it one literal.
func compacted(text []byte) []byte {
	var out []byte
	length := len(text)
	for length >= 0x80 {
		out = append(out, byte(length)|0x80)
		length >>= 7
	}
	out = append(out, byte(length))
	// A literal of 61 or more bytes says its length less one in two little-endian bytes.
	size := len(text) - 1
	out = append(out, 61<<2, byte(size), byte(size>>8))
	return append(out, text...)
}

type signedRelease struct {
	release *aRelease
	source  Source
}

func aSignedRelease(t *testing.T) signedRelease {
	t.Helper()
	sigstore, err := testsigstore.New()
	if err != nil {
		t.Fatal(err)
	}
	binary := []byte("#!/bin/sh\necho aeolus-trierarch 0.40.0\n")
	digest := sha256.Sum256(binary)
	bundle, err := sigstore.Bundle(testsigstore.Signing{Name: "aeolus-trierarch-linux-amd64", Digest: digest[:], Signer: "https://github.com/" + repository + "/.github/workflows/release.yml@refs/heads/main", Issuer: "https://token.actions.githubusercontent.com", IntegratedTime: time.Now().Add(time.Minute)})
	if err != nil {
		t.Fatal(err)
	}
	text, err := sigstore.TrustedRoot()
	if err != nil {
		t.Fatal(err)
	}
	trusted, err := attestation.ParseTrustedRoot(text)
	if err != nil {
		t.Fatal(err)
	}
	release := &aRelease{
		version: "0.40.0",
		binary:  binary,
		sums:    fmt.Sprintf("%x  aeolus-trierarch-darwin-arm64\n%s  aeolus-trierarch-linux-amd64\n", sha256.Sum256([]byte("another")), hex.EncodeToString(digest[:])),
		bundles: [][]byte{bundle},
		latest:  "0.40.0",
	}
	server := release.serve(t)
	return signedRelease{release: release, source: Source{API: server.URL, Repository: repository, Trusted: trusted, Client: server.Client()}}
}

func TestFetchTakesTheReleasesBinaryForTheSystemAndChipWhenItsChecksumAndAttestationHold(t *testing.T) {
	signed := aSignedRelease(t)

	binary, err := signed.source.Fetch(context.Background(), "0.40.0", "linux", "amd64")

	if err != nil || !bytes.Equal(binary, signed.release.binary) {
		t.Fatalf("Fetch(0.40.0) = %q, %v, want the release's binary", binary, err)
	}
}

func TestFetchReadsAnAttestationGitHubKeepsCompacted(t *testing.T) {
	signed := aSignedRelease(t)
	signed.release.isCompacted = true

	if _, err := signed.source.Fetch(context.Background(), "0.40.0", "linux", "amd64"); err != nil {
		t.Fatalf("Fetch(an attestation behind bundle_url) = %v, want nil", err)
	}
}

func TestFetchRefusesABinaryItsChecksumDoesNotName(t *testing.T) {
	for name, sums := range map[string]string{
		"another checksum": fmt.Sprintf("%x  aeolus-trierarch-linux-amd64\n", sha256.Sum256([]byte("another"))),
		"no checksum":      fmt.Sprintf("%x  aeolus-trierarch-darwin-arm64\n", sha256.Sum256([]byte("another"))),
	} {
		t.Run(name, func(t *testing.T) {
			signed := aSignedRelease(t)
			signed.release.sums = sums

			if _, err := signed.source.Fetch(context.Background(), "0.40.0", "linux", "amd64"); !errors.Is(err, ErrChecksum) {
				t.Fatalf("Fetch(%s) = %v, want ErrChecksum", name, err)
			}
		})
	}
}

func TestFetchRefusesABinaryWithNoAttestationThatHolds(t *testing.T) {
	other, err := testsigstore.New()
	if err != nil {
		t.Fatal(err)
	}
	signed := aSignedRelease(t)
	digest := sha256.Sum256(signed.release.binary)
	for name, bundles := range map[string]func() [][]byte{
		"none": func() [][]byte { return nil },
		"another sigstore's": func() [][]byte {
			bundle, err := other.Bundle(testsigstore.Signing{Name: "aeolus-trierarch-linux-amd64", Digest: digest[:], Signer: "https://github.com/" + repository + "/.github/workflows/release.yml@refs/heads/main", Issuer: "https://token.actions.githubusercontent.com", IntegratedTime: time.Now().Add(time.Minute)})
			if err != nil {
				t.Fatal(err)
			}
			return [][]byte{bundle}
		},
	} {
		t.Run(name, func(t *testing.T) {
			signed.release.bundles = bundles()

			if _, err := signed.source.Fetch(context.Background(), "0.40.0", "linux", "amd64"); !errors.Is(err, attestation.ErrUnverified) {
				t.Fatalf("Fetch(attested by %s) = %v, want ErrUnverified", name, err)
			}
		})
	}
}

func TestFetchSaysWhenTheReleaseHasNoBinaryForTheSystemAndChip(t *testing.T) {
	signed := aSignedRelease(t)

	if _, err := signed.source.Fetch(context.Background(), "0.40.0", "linux", "riscv64"); !errors.Is(err, ErrNoBinary) {
		t.Fatalf("Fetch(linux riscv64) = %v, want ErrNoBinary", err)
	}
	if _, err := signed.source.Fetch(context.Background(), "0.41.0", "linux", "amd64"); !errors.Is(err, ErrNoRelease) {
		t.Fatalf("Fetch(0.41.0, never released) = %v, want ErrNoRelease", err)
	}
}

func TestLatestIsTheVersionOfTheLatestRelease(t *testing.T) {
	signed := aSignedRelease(t)
	signed.release.latest = "0.41.2"

	if latest, err := signed.source.Latest(context.Background()); err != nil || latest != "0.41.2" {
		t.Fatalf("Latest() = %q, %v, want 0.41.2", latest, err)
	}
}

func TestSnappyReadsTheBundleGitHubKeptForCliCli(t *testing.T) {
	compactedText, err := os.ReadFile("testdata/cli-release-attestation.json.sn")
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile("testdata/cli-release-attestation.json")
	if err != nil {
		t.Fatal(err)
	}

	got, err := snappy(compactedText)
	if err != nil {
		t.Fatalf("snappy(cli/cli's bundle) = %v, want the bundle gh read", err)
	}

	var gotBundle, wantBundle any
	if err := json.Unmarshal(got, &gotBundle); err != nil {
		t.Fatalf("snappy(cli/cli's bundle) = %q, no JSON: %v", got, err)
	}
	if err := json.Unmarshal(want, &wantBundle); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gotBundle, wantBundle) {
		t.Fatalf("snappy(cli/cli's bundle) = %s, want the bundle gh read, %s", got, want)
	}
}

func TestSnappyRefusesWhatIsNotSnappy(t *testing.T) {
	for _, text := range [][]byte{nil, {0x05, 0x00}, {0x05, 0x08, 'a'}, {0x02, 0x04, 'a', 0x05, 0x00}} {
		if _, err := snappy(text); err == nil {
			t.Errorf("snappy(%x) = nil error, want one", text)
		}
	}
}
