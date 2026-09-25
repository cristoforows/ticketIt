// Package auth implements issue #54's security-bearing pieces of
// Owner sign-in: opaque token generation and hashing, persisted
// sessions, persisted anti-replay OAuth state, the Owner/linked-identity
// model, and a minimal GitHub OAuth client. internal/httpapi wires
// these into HTTP handlers and owns cookies; nothing here knows about
// http.ResponseWriter or *http.Request.
//
// Every token this package hands to a caller (session, state) is
// high-entropy and opaque; only its SHA-256 hash is ever persisted, so
// a database read alone never yields a value usable to authenticate.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"time"
)

// tokenBytes is the raw entropy behind every opaque token this package
// generates (sessions and OAuth state alike) -- 256 bits, the same
// order of magnitude widely used for bearer tokens/session ids.
const tokenBytes = 32

// StateTTL is how long an OAuth `state` value remains valid: long
// enough for a real user to complete the provider's consent screen,
// short enough to keep a stolen-but-unused value's window small.
const StateTTL = 10 * time.Minute

// generateOpaqueToken returns a fresh, high-entropy, URL-safe token.
func generateOpaqueToken() (string, error) {
	b := make([]byte, tokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("failed to generate a random token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// hashToken returns raw's SHA-256 hash, the only form of a session or
// state token ever persisted (see the package doc).
func hashToken(raw string) []byte {
	sum := sha256.Sum256([]byte(raw))
	return sum[:]
}
