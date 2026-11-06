// Package proxytoken is each session's model proxy token (headless H16): a
// random token of its own, fresh at each start, kept in the session's folder
// beside its hold's files, mode 600, with the harness it may reach. The model
// proxy takes a token only while that hold runs, so a stopped session's token
// is refused, and the folder goes with the session.
package proxytoken

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
)

// file is the token's file in the session's folder; holdPID the hold's pid file beside it, as package hold names it.
const (
	file    = "proxy-token"
	holdPID = "hold.pid"
)

// tokenBytes is how many random bytes a token holds.
const tokenBytes = 32

var shipIDPattern = regexp.MustCompile(`^shp_[0-7][0-9a-hjkmnp-tv-z]{25}$`)

// Token is a session's token and the harness whose vendor it may reach.
type Token struct {
	Harness string `json:"harness"`
	Token   string `json:"token"`
}

// New is a fresh token for one start of a session.
func New() string {
	bytes := make([]byte, tokenBytes)
	_, _ = rand.Read(bytes)
	return base64.RawURLEncoding.EncodeToString(bytes)
}

// Write keeps the token in the session's folder, which only its user reads: a command line is anyone's to see.
func Write(folder string, token Token) error {
	text, err := json.Marshal(token)
	if err != nil {
		return err
	}
	path := filepath.Join(folder, file)
	if err := os.WriteFile(path, text, 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

// Read is the token kept in the session's folder; false without one.
func Read(folder string) (Token, bool) {
	text, err := os.ReadFile(filepath.Join(folder, file))
	if err != nil {
		return Token{}, false
	}
	var token Token
	if json.Unmarshal([]byte(strings.TrimSpace(string(text))), &token) != nil || token.Harness == "" || token.Token == "" {
		return Token{}, false
	}
	return token, true
}

// IsHoldRunning is whether the hold of the session whose folder it is runs.
func IsHoldRunning(folder string) bool {
	text, err := os.ReadFile(filepath.Join(folder, holdPID))
	if err != nil {
		return false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(text)))
	return err == nil && pid > 1 && syscall.Kill(pid, 0) == nil
}

// SessionOf is the ship whose running session holds the token for the harness; false for any other token.
func SessionOf(sessions string, harness string, token string) (string, bool) {
	if token == "" {
		return "", false
	}
	folders, err := os.ReadDir(sessions)
	if err != nil {
		return "", false
	}
	for _, each := range folders {
		if !shipIDPattern.MatchString(each.Name()) {
			continue
		}
		folder := filepath.Join(sessions, each.Name())
		held, ok := Read(folder)
		if ok && held.Harness == harness && subtle.ConstantTimeCompare([]byte(token), []byte(held.Token)) == 1 && IsHoldRunning(folder) {
			return each.Name(), true
		}
	}
	return "", false
}
