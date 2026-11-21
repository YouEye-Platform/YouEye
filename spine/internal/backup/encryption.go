package backup

import (
	"context"
	"fmt"
	"os/exec"
	"strconv"
)

// ArchiveEncryption is how a backup archive (.tar.enc) is encrypted and authenticated: OpenSSL `enc` with the backup
// passphrase, the key derived by PBKDF2, and an HMAC-SHA256 file (.hmac) beside it. Spine reports it with every
// finished backup (StatusFile.Encryption); the Control Panel records it in the set's backup-set.json and sends it back
// with the restore of any archive of that set.
type ArchiveEncryption struct {
	Cipher     string `json:"cipher"`
	KDF        string `json:"kdf"`
	Digest     string `json:"digest"`
	Iterations int    `json:"iterations"`
	// MAC is how the .hmac file's key is made. archiveMACPBKDF2: PBKDF2 with the same digest and iterations, salted
	// with archiveMACLabel and the archive's own OpenSSL salt, so a passphrase guess costs as much against the .hmac
	// file as against the ciphertext. Empty (archives up to 0.6.14, and 0.6.15 builds before the field): the raw
	// passphrase is the HMAC key.
	MAC string `json:"mac,omitempty"`
}

// archiveMACPBKDF2 names the .hmac key derivation of ArchiveEncryption.MAC.
const archiveMACPBKDF2 = "hmac-sha256-pbkdf2"

// archiveMACLabel keeps the .hmac key apart from the encryption key: both are PBKDF2 of the passphrase, and only
// this one has the label in front of the archive's salt.
const archiveMACLabel = "youeye-backup-archive-mac:"

// currentArchiveEncryption is what a new backup uses. Every parameter is passed to OpenSSL, so an OpenSSL with other
// defaults still writes and reads the same archive (OpenSSL changed the default digest of `enc` once already). The
// values are those YouEye always used, so every Spine reads the new archives too.
var currentArchiveEncryption = ArchiveEncryption{Cipher: "aes-256-cbc", KDF: "pbkdf2", Digest: "sha256", Iterations: 10000,
	MAC: archiveMACPBKDF2}

// legacyArchiveEncryption is what an archive with no record used (YouEye up to 0.6.14): `-aes-256-cbc -pbkdf2` and
// OpenSSL 3's defaults for the rest (SHA-256, 10000 iterations), and the raw passphrase as the .hmac key.
var legacyArchiveEncryption = ArchiveEncryption{Cipher: "aes-256-cbc", KDF: "pbkdf2", Digest: "sha256", Iterations: 10000}

// validate accepts what this Spine can read: the one cipher, KDF and digest, and a sane iteration count.
func (e ArchiveEncryption) validate() error {
	if e.Cipher != "aes-256-cbc" || e.KDF != "pbkdf2" || e.Digest != "sha256" {
		return fmt.Errorf("the backup uses encryption this Spine cannot read (%s, %s, %s)", e.Cipher, e.KDF, e.Digest)
	}
	if e.Iterations < 1000 || e.Iterations > 10_000_000 {
		return fmt.Errorf("the backup records an invalid key-derivation iteration count %d", e.Iterations)
	}
	if e.MAC != "" && e.MAC != archiveMACPBKDF2 {
		return fmt.Errorf("the backup uses archive authentication this Spine cannot read (%s)", e.MAC)
	}
	return nil
}

// restoreEncryption is the encryption to decrypt with: the recorded one, or the legacy one when there is no record.
func restoreEncryption(recorded *ArchiveEncryption) (ArchiveEncryption, error) {
	if recorded == nil {
		return legacyArchiveEncryption, nil
	}
	if err := recorded.validate(); err != nil {
		return ArchiveEncryption{}, err
	}
	return *recorded, nil
}

func (e ArchiveEncryption) opensslArgs() []string {
	return []string{"-" + e.Cipher, "-pbkdf2", "-md", e.Digest, "-iter", strconv.Itoa(e.Iterations)}
}

// encryptCommand encrypts input to output with a fresh salt.
func encryptCommand(e ArchiveEncryption, passphrase, input, output string) *exec.Cmd {
	args := append([]string{"enc"}, e.opensslArgs()...)
	return opensslWithPassphrase(passphrase, append(args, "-salt", "-in", input, "-out", output)...)
}

// decryptCommand decrypts input to output. It ends with ctx (stepCommand).
func decryptCommand(ctx context.Context, e ArchiveEncryption, passphrase, input, output string) *exec.Cmd {
	args := append([]string{"enc", "-d"}, e.opensslArgs()...)
	return opensslStep(ctx, passphrase, append(args, "-in", input, "-out", output)...)
}
