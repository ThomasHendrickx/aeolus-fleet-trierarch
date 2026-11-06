package secrets

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/nacl/box"
)

// Key is the trierarch's sealing key pair: its public key, in the report, is what the trierarch plugin seals each secret to; its private key never leaves the machine.
type Key struct {
	public  [32]byte
	private [32]byte
}

// Public is the public key as the report states it: standard base64 of its 32 bytes.
func (k Key) Public() string {
	return base64.StdEncoding.EncodeToString(k.public[:])
}

// open opens a sealed box made for this key; false when it was not.
func (k Key) open(sealed []byte) ([]byte, bool) {
	return box.OpenAnonymous(nil, sealed, &k.public, &k.private)
}

// keyOf is the key pair of a private key.
func keyOf(private []byte) (Key, error) {
	parsed, err := ecdh.X25519().NewPrivateKey(private)
	if err != nil {
		return Key{}, err
	}
	var key Key
	copy(key.private[:], private)
	copy(key.public[:], parsed.PublicKey().Bytes())
	return key, nil
}

// LoadOrMake is the key kept at path, made there when there is none, the file mode 600 either way. A file that holds no key is refused, never made over: a new key would leave every secret sealed to the old one unreadable.
func LoadOrMake(path string) (Key, error) {
	text, err := os.ReadFile(path)
	if err == nil {
		private, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(text)))
		if err != nil || len(private) != 32 {
			return Key{}, fmt.Errorf("%s holds no sealing key", path)
		}
		if err := os.Chmod(path, 0o600); err != nil {
			return Key{}, err
		}
		return keyOf(private)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return Key{}, err
	}
	_, private, err := box.GenerateKey(rand.Reader)
	if err != nil {
		return Key{}, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return Key{}, err
	}
	// Written beside and renamed into place, so a stop mid-write leaves no half key.
	partial := path + ".partial"
	if err := os.WriteFile(partial, []byte(base64.StdEncoding.EncodeToString(private[:])+"\n"), 0o600); err != nil {
		return Key{}, err
	}
	if err := os.Chmod(partial, 0o600); err != nil {
		return Key{}, err
	}
	if err := os.Rename(partial, path); err != nil {
		return Key{}, fmt.Errorf("keep the sealing key: %w", err)
	}
	return keyOf(private[:])
}
