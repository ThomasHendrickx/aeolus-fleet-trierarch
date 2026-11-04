// Command testsigstore signs files as GitHub's release workflow attests them,
// with a Sigstore of its own, for the contract suite: `testsigstore <folder>
// <file>...` writes the Sigstore's trusted_root.json to the folder, and each
// file's attestation bundle as <its name>.bundle.json. Only tests run it.
package main

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/testsigstore"
)

const signer = "https://github.com/ThomasHendrickx/aeolus-fleet-trierarch/.github/workflows/release.yml@refs/heads/main"

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "Usage: testsigstore <folder> <file>...")
		os.Exit(2)
	}
	if err := sign(os.Args[1], os.Args[2:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func sign(folder string, files []string) error {
	sigstore, err := testsigstore.New()
	if err != nil {
		return err
	}
	root, err := sigstore.TrustedRoot()
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(folder, "trusted_root.json"), root, 0o644); err != nil {
		return err
	}
	for _, file := range files {
		content, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		digest := sha256.Sum256(content)
		name := filepath.Base(file)
		bundle, err := sigstore.Bundle(testsigstore.Signing{Name: name, Digest: digest[:], Signer: signer, Issuer: "https://token.actions.githubusercontent.com", IntegratedTime: time.Now().Add(time.Minute)})
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(folder, name+".bundle.json"), bundle, 0o644); err != nil {
			return err
		}
	}
	return nil
}
