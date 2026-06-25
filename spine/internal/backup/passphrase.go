package backup

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const passphraseFile = "/var/lib/youeye/backup/.passphrase"

// StorePassphrase encrypts the backup passphrase using AES-256-GCM with the
// deploy secret as the key, and stores it on disk.
func StorePassphrase(passphrase string, deploySecretPath string) error {
	key, err := deriveKey(deploySecretPath)
	if err != nil {
		return fmt.Errorf("derive key: %w", err)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return fmt.Errorf("create cipher: %w", err)
	}

	aesGCM, err := cipher.NewGCM(block)
	if err != nil {
		return fmt.Errorf("create GCM: %w", err)
	}

	nonce := make([]byte, aesGCM.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return fmt.Errorf("generate nonce: %w", err)
	}

	ciphertext := aesGCM.Seal(nonce, nonce, []byte(passphrase), nil)

	// Ensure directory exists
	if err := os.MkdirAll(filepath.Dir(passphraseFile), 0700); err != nil {
		return fmt.Errorf("create dir: %w", err)
	}

	// Store as hex-encoded string
	encoded := hex.EncodeToString(ciphertext)
	if err := os.WriteFile(passphraseFile, []byte(encoded), 0600); err != nil {
		return fmt.Errorf("write passphrase: %w", err)
	}

	return nil
}

// ReadPassphrase decrypts the stored backup passphrase using the deploy secret.
func ReadPassphrase(deploySecretPath string) (string, error) {
	key, err := deriveKey(deploySecretPath)
	if err != nil {
		return "", fmt.Errorf("derive key: %w", err)
	}

	encoded, err := os.ReadFile(passphraseFile)
	if err != nil {
		return "", fmt.Errorf("read passphrase file: %w", err)
	}

	ciphertext, err := hex.DecodeString(string(encoded))
	if err != nil {
		return "", fmt.Errorf("decode hex: %w", err)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("create cipher: %w", err)
	}

	aesGCM, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("create GCM: %w", err)
	}

	nonceSize := aesGCM.NonceSize()
	if len(ciphertext) < nonceSize {
		return "", fmt.Errorf("ciphertext too short")
	}

	nonce, ciphertext := ciphertext[:nonceSize], ciphertext[nonceSize:]
	plaintext, err := aesGCM.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("decrypt: %w", err)
	}

	return string(plaintext), nil
}

// deriveKey reads the deploy secret and derives a 32-byte AES-256 key via SHA-256.
func deriveKey(deploySecretPath string) ([]byte, error) {
	secret, err := os.ReadFile(deploySecretPath)
	if err != nil {
		return nil, fmt.Errorf("read deploy secret: %w", err)
	}

	hash := sha256.Sum256(secret)
	return hash[:], nil
}
