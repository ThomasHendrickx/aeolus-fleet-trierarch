// Package release is where upgrade takes a version of the Go trierarch from:
// the GitHub Release v<version> of this repository, its binary for the
// machine's system and chip (aeolus-trierarch-<goos>-<goarch>), taken only
// when SHA256SUMS of the release names its digest and a GitHub artifact
// attestation, signed by the repository's release workflow, holds for it.
package release

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/attestation"
)

// GitHub is the API the release source answers on, and Repository the repository whose releases upgrade takes.
const (
	GitHub     = "https://api.github.com"
	Repository = "ThomasHendrickx/aeolus-fleet-trierarch"
)

// The reasons Fetch takes no binary, besides attestation.ErrUnverified.
var (
	ErrNoRelease = errors.New("no such release")
	ErrNoBinary  = errors.New("the release has no binary for this system and chip")
	ErrChecksum  = errors.New("the binary is not the one SHA256SUMS names")
)

// The most upgrade reads of one answer: a binary, and anything else.
const (
	maxBinary = 512 << 20
	maxAnswer = 16 << 20
)

// Source is the GitHub API of the repository's releases and attestations, and the trusted root an attestation is checked against.
type Source struct {
	API        string
	Repository string
	Trusted    attestation.TrustedRoot
	Client     *http.Client
}

// Name is the binary's asset name for a system and chip, as Go names them.
func Name(goos string, goarch string) string {
	return "aeolus-trierarch-" + goos + "-" + goarch
}

// Latest is the version of the repository's latest release.
func (s Source) Latest(ctx context.Context) (string, error) {
	var latest struct {
		Tag string `json:"tag_name"`
	}
	if err := s.readJSON(ctx, s.API+"/repos/"+s.Repository+"/releases/latest", &latest); err != nil {
		return "", fmt.Errorf("read the latest release of %s: %w", s.Repository, err)
	}
	return strings.TrimPrefix(latest.Tag, "v"), nil
}

// Fetch is the binary of the version for the system and chip, once its checksum and its attestation hold.
func (s Source) Fetch(ctx context.Context, version string, goos string, goarch string) ([]byte, error) {
	var tagged struct {
		Assets []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	tag := "v" + version
	if err := s.readJSON(ctx, s.API+"/repos/"+s.Repository+"/releases/tags/"+tag, &tagged); err != nil {
		return nil, fmt.Errorf("read the release %s of %s: %w", tag, s.Repository, err)
	}
	urls := map[string]string{}
	for _, asset := range tagged.Assets {
		urls[asset.Name] = asset.URL
	}
	name := Name(goos, goarch)
	binaryURL, sumsURL := urls[name], urls["SHA256SUMS"]
	if binaryURL == "" || sumsURL == "" {
		return nil, fmt.Errorf("%w: the release %s has no %s with SHA256SUMS", ErrNoBinary, tag, name)
	}
	binary, err := s.read(ctx, binaryURL, maxBinary)
	if err != nil {
		return nil, fmt.Errorf("download %s of %s: %w", name, tag, err)
	}
	sums, err := s.read(ctx, sumsURL, maxAnswer)
	if err != nil {
		return nil, fmt.Errorf("download SHA256SUMS of %s: %w", tag, err)
	}
	digest := sha256.Sum256(binary)
	if named, isNamed := checksumOf(string(sums), name); !isNamed || !strings.EqualFold(named, hex.EncodeToString(digest[:])) {
		return nil, fmt.Errorf("%w: %s of %s is sha256:%x, SHA256SUMS names %q", ErrChecksum, name, tag, digest, named)
	}
	bundles, err := s.attestations(ctx, digest)
	if err != nil {
		return nil, err
	}
	identity := attestation.Identity{Issuer: "https://token.actions.githubusercontent.com", Workflow: "https://github.com/" + s.Repository + "/.github/workflows/release.yml"}
	if err := attestation.VerifyAny(bundles, digest, s.Trusted, identity); err != nil {
		return nil, fmt.Errorf("%s of %s: %w", name, tag, err)
	}
	return binary, nil
}

// checksumOf is the checksum SHA256SUMS (sha256sum's lines, `<hex>  <name>`, a binary's name after a `*`) names for the file.
func checksumOf(sums string, name string) (string, bool) {
	for _, line := range strings.Split(sums, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && strings.TrimPrefix(fields[1], "*") == name {
			return fields[0], true
		}
	}
	return "", false
}

// attestations are the bundles GitHub keeps for the digest: inline, or behind bundle_url, compacted with Snappy.
func (s Source) attestations(ctx context.Context, digest [32]byte) ([][]byte, error) {
	var answer struct {
		Attestations []struct {
			Bundle json.RawMessage `json:"bundle"`
			URL    string          `json:"bundle_url"`
		} `json:"attestations"`
	}
	err := s.readJSON(ctx, fmt.Sprintf("%s/repos/%s/attestations/sha256:%x", s.API, s.Repository, digest), &answer)
	if errors.Is(err, ErrNoRelease) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read the attestations of sha256:%x: %w", digest, err)
	}
	var bundles [][]byte
	for _, each := range answer.Attestations {
		if len(each.Bundle) > 0 && string(each.Bundle) != "null" {
			bundles = append(bundles, each.Bundle)
			continue
		}
		if each.URL == "" {
			continue
		}
		compacted, err := s.read(ctx, each.URL, maxAnswer)
		if err != nil {
			return nil, fmt.Errorf("download an attestation of sha256:%x: %w", digest, err)
		}
		bundle, err := snappy(compacted)
		if err != nil {
			return nil, fmt.Errorf("read an attestation of sha256:%x: %w", digest, err)
		}
		bundles = append(bundles, bundle)
	}
	return bundles, nil
}

func (s Source) readJSON(ctx context.Context, url string, into any) error {
	text, err := s.read(ctx, url, maxAnswer)
	if err != nil {
		return err
	}
	return json.Unmarshal(text, into)
}

// read is the answer to a GET, at most limit bytes; ErrNoRelease when GitHub has nothing there.
func (s Source) read(ctx context.Context, url string, limit int64) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	client := s.Client
	if client == nil {
		client = http.DefaultClient
	}
	answer, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer answer.Body.Close()
	if answer.StatusCode == http.StatusNotFound {
		return nil, ErrNoRelease
	}
	if answer.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s answered %s", url, answer.Status)
	}
	text, err := io.ReadAll(io.LimitReader(answer.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(text)) > limit {
		return nil, fmt.Errorf("%s answered more than %d bytes", url, limit)
	}
	return text, nil
}
