package installer

import (
	"bytes"
	"crypto/rand"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	yescrypt "github.com/openwall/yescrypt-go"
)

const cryptSaltAlphabet = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

func validateRootPassphrase(password []byte) error {
	if len(password) == 0 || len(password) > 256 || !utf8.Valid(password) {
		return fmt.Errorf("root password must be non-empty valid text of at most 256 bytes")
	}
	if strings.IndexFunc(string(password), unicode.IsControl) >= 0 {
		return fmt.Errorf("root password cannot contain control characters")
	}
	return nil
}

func hashRootPassphrase(password []byte) (string, error) {
	if err := validateRootPassphrase(password); err != nil {
		return "", err
	}
	salt, err := randomCryptSalt(16)
	if err != nil {
		return "", err
	}
	hash, err := yescrypt.Hash(password, []byte("$y$j9T$"+salt))
	if err != nil {
		return "", fmt.Errorf("hash developer root password: %w", err)
	}
	if !validYescryptHash(string(hash)) {
		return "", fmt.Errorf("generated developer root password hash is invalid")
	}
	return string(hash), nil
}

func buildDevelopmentAccessPolicy(passwordSSH bool, passwordValue, confirmValue string, existing developmentAccessPolicy) (developmentAccessPolicy, error) {
	// The root login is an always-available, password-authenticated local
	// recovery surface. Development access controls only whether the same
	// credential may also be used for SSH on the directly connected subnet.
	if passwordValue == "" && confirmValue == "" && validYescryptHash(existing.PasswordHash) {
		existing.Schema = developmentAccessSchema
		existing.LocalRootConsole = true
		existing.RootPasswordSSH = passwordSSH
		existing.SSHNetworkScope = ""
		if passwordSSH {
			existing.SSHNetworkScope = "local-subnet"
		}
		return existing, validateDevelopmentAccessPolicy(existing)
	}
	password := []byte(passwordValue)
	confirm := []byte(confirmValue)
	defer wipeBytes(password)
	defer wipeBytes(confirm)
	if !bytes.Equal(password, confirm) {
		return developmentAccessPolicy{}, fmt.Errorf("developer root passwords do not match")
	}
	hash, err := hashRootPassphrase(password)
	if err != nil {
		return developmentAccessPolicy{}, err
	}
	policy := developmentAccessPolicy{
		Schema:           developmentAccessSchema,
		LocalRootConsole: true,
		RootPasswordSSH:  passwordSSH,
		PasswordHash:     hash,
	}
	if passwordSSH {
		policy.SSHNetworkScope = "local-subnet"
	}
	return policy, validateDevelopmentAccessPolicy(policy)
}

func randomCryptSalt(byteLength int) (string, error) {
	if byteLength < 8 || byteLength > 32 {
		return "", fmt.Errorf("yescrypt salt length is invalid")
	}
	raw := make([]byte, byteLength)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate yescrypt salt: %w", err)
	}
	defer wipeBytes(raw)
	return encodeCryptBase64(raw), nil
}

func encodeCryptBase64(source []byte) string {
	output := make([]byte, 0, (len(source)*8+5)/6)
	for index := 0; index < len(source); {
		value, bits := uint32(0), 0
		for ; bits < 24 && index < len(source); bits += 8 {
			value |= uint32(source[index]) << bits
			index++
		}
		for ; bits > 0; bits -= 6 {
			output = append(output, cryptSaltAlphabet[value&0x3f])
			value >>= 6
		}
	}
	return string(output)
}

func wipeBytes(value []byte) {
	for index := range value {
		value[index] = 0
	}
}
