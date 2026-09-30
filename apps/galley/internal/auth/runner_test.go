package auth

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"regexp"
	"strings"
	"testing"
)

func TestNewRunnerToken_ShapeAndHashOfFullToken(t *testing.T) {
	shape := regexp.MustCompile(`^tir_[A-Za-z0-9_-]{43}$`)
	seen := map[string]bool{}
	for range 50 {
		token, hash, err := NewRunnerToken()
		if err != nil {
			t.Fatal(err)
		}
		if !shape.MatchString(token) {
			t.Fatalf("token %q does not match %s", token, shape)
		}
		if seen[token] {
			t.Fatalf("duplicate token %q", token)
		}
		seen[token] = true
		sum := sha256.Sum256([]byte(token))
		if !bytes.Equal(hash, sum[:]) {
			t.Fatalf("hash is not SHA-256 of the full token")
		}
		parsed, ok := RunnerTokenHash(token)
		if !ok || !bytes.Equal(parsed, hash) {
			t.Fatalf("RunnerTokenHash(%q) = %x, %v; want %x, true", token, parsed, ok, hash)
		}
	}
}

func TestRunnerTokenHash_RejectsMalformedTokens(t *testing.T) {
	token, _, err := NewRunnerToken()
	if err != nil {
		t.Fatal(err)
	}
	encoded := strings.TrimPrefix(token, RunnerTokenPrefix)
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	lastValue := strings.IndexByte(alphabet, encoded[len(encoded)-1])
	nonCanonical := encoded[:len(encoded)-1] + string(alphabet[lastValue|1])
	for name, candidate := range map[string]string{
		"empty":             "",
		"prefix only":       RunnerTokenPrefix,
		"no prefix":         encoded,
		"wrong prefix":      "tis_" + encoded,
		"upper-case prefix": "TIR_" + encoded,
		"one short":         token[:len(token)-1],
		"one long":          token + "A",
		"padded":            token + "=",
		"standard alphabet": RunnerTokenPrefix + "+" + encoded[1:],
		"invalid character": RunnerTokenPrefix + "!" + encoded[1:],
		"whitespace":        " " + token,
		"non-canonical":     RunnerTokenPrefix + nonCanonical,
		"session-shaped":    base64.RawURLEncoding.EncodeToString(make([]byte, 32)),
	} {
		if _, ok := RunnerTokenHash(candidate); ok {
			t.Errorf("%s: RunnerTokenHash(%q) accepted a malformed token", name, candidate)
		}
	}
}
