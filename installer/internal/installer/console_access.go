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
		return "", fmt.Errorf("hash root password: %w", err)
	}
	if !validYescryptHash(string(hash)) {
		return "", fmt.Errorf("generated root password hash is invalid")
	}
	return string(hash), nil
}

// buildConsoleAccess returns the console access record the installer writes.
// Without a root password root stays locked and password SSH stays off: the
// owner and admins get console accounts from the Control Panel. A root
// password (advanced, for emergencies) may also allow password SSH from the
// local subnet. Blank password fields keep a root password chosen earlier.
func buildConsoleAccess(rootPassword, passwordSSH bool, passwordValue, confirmValue string, existing consoleAccessPolicy) (consoleAccessPolicy, error) {
	if !rootPassword {
		return defaultConsoleAccessPolicy(), nil
	}
	if passwordValue == "" && confirmValue == "" && validYescryptHash(existing.RootPasswordHash) {
		existing.Schema = consoleAccessSchema
		existing.PasswordSSH = passwordSSH
		return existing, validateConsoleAccessPolicy(existing)
	}
	password := []byte(passwordValue)
	confirm := []byte(confirmValue)
	defer wipeBytes(password)
	defer wipeBytes(confirm)
	if !bytes.Equal(password, confirm) {
		return consoleAccessPolicy{}, fmt.Errorf("root passwords do not match")
	}
	hash, err := hashRootPassphrase(password)
	if err != nil {
		return consoleAccessPolicy{}, err
	}
	policy := consoleAccessPolicy{Schema: consoleAccessSchema, RootPasswordHash: hash, PasswordSSH: passwordSSH}
	return policy, validateConsoleAccessPolicy(policy)
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

// consoleAccessSummary is the one-line review of a console access record.
func consoleAccessSummary(policy consoleAccessPolicy) string {
	if policy.RootPasswordHash == "" {
		return "admins sign in with YouEye ID · root locked"
	}
	if policy.PasswordSSH {
		return "admins sign in with YouEye ID · root password set · password SSH on the local network"
	}
	return "admins sign in with YouEye ID · root password set"
}
