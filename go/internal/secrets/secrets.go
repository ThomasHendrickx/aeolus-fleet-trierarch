// Package secrets is the credentials of the crew-time MCP servers
// (docs/design/crew-mcp-servers.md, decisions M5 and M6): the trierarch
// plugin keeps them and sends them whole, in a fleet's MCP configuration
// (package mcpconfiguration), to each trierarch, each sealed to the public key
// that trierarch made and reports, as a NaCl anonymous sealed box (libsodium's
// crypto_box_seal), so the fleet stores only what it cannot read. The
// trierarch opens them with its private key, keeps them mode 600, and only the
// MCP proxy reads them. No refusal says a value.
package secrets

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Scheme names the sealing in the report.
const Scheme = "nacl-sealed-box"

const (
	// nameMaxLength is the most a name holds, as a server's name.
	nameMaxLength = 100
	// valueMaxLength is the most bytes a value holds: it goes into one header.
	valueMaxLength = 8192
)

var namePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)

// IsName says whether a name is one a secret can have.
func IsName(name string) bool {
	return len(name) <= nameMaxLength && namePattern.MatchString(name)
}

// IsValue says whether a value can go into a header as it is.
func IsValue(value []byte) bool {
	return len(value) > 0 && len(value) <= valueMaxLength && utf8.Valid(value) && !bytes.ContainsAny(value, "\r\n\x00")
}

type sealedEntry struct {
	Name   string `json:"name"`
	Sealed string `json:"sealed"`
}

// Read is the secrets the message's payload carries, each opened with the key, or why not: sealed to this key, each name a name given once, each value one a header can carry. Nothing of it is taken when one does not fit.
func Read(payload string, key Key) (map[string]string, error) {
	shape := errors.New(`the secrets are { "publicKey", "secrets": [{ "name", "sealed" }] }`)
	var message struct {
		PublicKey string         `json:"publicKey"`
		Secrets   *[]sealedEntry `json:"secrets"`
	}
	decoder := json.NewDecoder(strings.NewReader(payload))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&message) != nil || message.Secrets == nil {
		return nil, shape
	}
	if message.PublicKey != key.Public() {
		return nil, errors.New("the secrets are sealed to another key than this trierarch's")
	}
	opened := map[string]string{}
	for _, entry := range *message.Secrets {
		if !IsName(entry.Name) {
			return nil, errors.New("a secret's name is lowercase letters, digits, dots, hyphens and underscores, at most 100, and never a path")
		}
		if _, ok := opened[entry.Name]; ok {
			return nil, fmt.Errorf("%s: a secret is named once", entry.Name)
		}
		sealed, err := base64.StdEncoding.DecodeString(entry.Sealed)
		if err != nil {
			return nil, fmt.Errorf("%s: the sealed value is not standard base64", entry.Name)
		}
		value, ok := key.open(sealed)
		if !ok {
			return nil, fmt.Errorf("%s: does not open with this trierarch's key", entry.Name)
		}
		if !IsValue(value) {
			return nil, fmt.Errorf("%s: a value is 1 to %d bytes of UTF-8 with no line break or NUL", entry.Name, valueMaxLength)
		}
		opened[entry.Name] = string(value)
	}
	return opened, nil
}
