package auth

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"strings"
)

const RunnerTokenPrefix = "tir_"

var runnerTokenEncoding = base64.RawURLEncoding.Strict()

func NewRunnerToken() (token string, hash []byte, err error) {
	b := make([]byte, tokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", nil, fmt.Errorf("failed to generate a runner token: %w", err)
	}
	token = RunnerTokenPrefix + runnerTokenEncoding.EncodeToString(b)
	return token, hashToken(token), nil
}

func RunnerTokenHash(token string) ([]byte, bool) {
	encoded, ok := strings.CutPrefix(token, RunnerTokenPrefix)
	if !ok || len(encoded) != runnerTokenEncoding.EncodedLen(tokenBytes) {
		return nil, false
	}
	if b, err := runnerTokenEncoding.DecodeString(encoded); err != nil || len(b) != tokenBytes {
		return nil, false
	}
	return hashToken(token), true
}
