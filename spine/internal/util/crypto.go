// Package util provides common utilities for Spine commands.
package util

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"log"
)

// GenerateJWTSecret creates a cryptographically secure random JWT secret.
func GenerateJWTSecret() string {
	bytes := make([]byte, 64)
	if _, err := rand.Read(bytes); err != nil {
		log.Fatalf("FATAL: crypto/rand failed — system cannot generate secure secrets: %v", err)
	}
	return base64.URLEncoding.EncodeToString(bytes)
}

// GenerateRandomPassword creates a cryptographically secure random password of the given length.
func GenerateRandomPassword(length int) string {
	bytes := make([]byte, length)
	if _, err := rand.Read(bytes); err != nil {
		log.Fatalf("FATAL: crypto/rand failed — system cannot generate secure secrets: %v", err)
	}
	return base64.URLEncoding.EncodeToString(bytes)[:length]
}

// GenerateBridgeToken creates a 64-char hex token (32 random bytes),
// matching the format used by the Control Panel's getBridgeToken().
func GenerateBridgeToken() string {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		log.Fatalf("FATAL: crypto/rand failed — system cannot generate secure secrets: %v", err)
	}
	return fmt.Sprintf("%x", bytes)
}
