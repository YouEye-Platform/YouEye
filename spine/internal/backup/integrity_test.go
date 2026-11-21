package backup

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const macPassphrase = "correct horse battery staple"

// writeSaltedArchive writes bytes that start like an `openssl enc -salt` archive.
func writeSaltedArchive(t *testing.T, filename, salt, body string) {
	t.Helper()
	if err := os.WriteFile(filename, []byte(opensslSaltHeader+salt+body), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestAuthenticatedArchiveRejectsWrongPassphraseAndMutation(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "backup.tar.enc")
	writeSaltedArchive(t, filename, "12345678", "encrypted archive bytes")
	if err := writeArchiveMAC(filename, macPassphrase, currentArchiveEncryption); err != nil {
		t.Fatal(err)
	}
	if err := verifyArchiveMAC(filename, macPassphrase, currentArchiveEncryption); err != nil {
		t.Fatal(err)
	}
	if err := verifyArchiveMAC(filename, "wrong passphrase", currentArchiveEncryption); err == nil {
		t.Fatal("accepted wrong passphrase")
	}
	writeSaltedArchive(t, filename, "12345678", "mutated archive bytes")
	if err := verifyArchiveMAC(filename, macPassphrase, currentArchiveEncryption); err == nil {
		t.Fatal("accepted mutated ciphertext")
	}
	// The salt is part of the key: a changed salt is refused too.
	writeSaltedArchive(t, filename, "87654321", "encrypted archive bytes")
	if err := verifyArchiveMAC(filename, macPassphrase, currentArchiveEncryption); err == nil {
		t.Fatal("accepted a changed salt")
	}
}

// A new .hmac file is keyed by PBKDF2 (the recorded iterations, the label and the archive's salt), never by the raw
// passphrase: guessing the passphrase against it costs as much as against the ciphertext.
func TestArchiveMACKeyIsDerivedByPBKDF2(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "backup.tar.enc")
	writeSaltedArchive(t, filename, "12345678", "encrypted archive bytes")
	if err := writeArchiveMAC(filename, macPassphrase, currentArchiveEncryption); err != nil {
		t.Fatal(err)
	}
	written, err := os.ReadFile(filename + ".hmac")
	if err != nil {
		t.Fatal(err)
	}
	content, _ := os.ReadFile(filename)
	raw := hmac.New(sha256.New, []byte(macPassphrase))
	raw.Write(content)
	if strings.TrimSpace(string(written)) == hex.EncodeToString(raw.Sum(nil)) {
		t.Fatal("the .hmac file is keyed with the raw passphrase")
	}
	if err := verifyArchiveMAC(filename, macPassphrase, legacyArchiveEncryption); err == nil {
		t.Fatal("a derived-key .hmac verified as a raw-passphrase one")
	}
	// Other iterations give another key.
	other := currentArchiveEncryption
	other.Iterations = 20000
	if err := verifyArchiveMAC(filename, macPassphrase, other); err == nil {
		t.Fatal("verified with other iterations")
	}
	// The record says so, and the Control Panel writes it into backup-set.json.
	if currentArchiveEncryption.MAC != archiveMACPBKDF2 {
		t.Fatalf("current MAC %q", currentArchiveEncryption.MAC)
	}
}

// An archive made up to 0.6.14 (no record) or by a 0.6.15 build before the MAC field (a record without `mac`) has a
// .hmac keyed with the raw passphrase, and still verifies.
func TestArchiveMACWithoutRecordVerifiesTheOldWay(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "backup.tar.enc")
	// Old archives were checked over the whole file whatever its header; this one has none.
	if err := os.WriteFile(filename, []byte("encrypted archive bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	content, _ := os.ReadFile(filename)
	raw := hmac.New(sha256.New, []byte(macPassphrase))
	raw.Write(content)
	if err := os.WriteFile(filename+".hmac", []byte(hex.EncodeToString(raw.Sum(nil))+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	withoutRecord, err := restoreEncryption(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := verifyArchiveMAC(filename, macPassphrase, withoutRecord); err != nil {
		t.Fatalf("a 0.6.14 archive does not verify: %v", err)
	}
	recordWithoutMAC := ArchiveEncryption{Cipher: "aes-256-cbc", KDF: "pbkdf2", Digest: "sha256", Iterations: 10000}
	encryption, err := restoreEncryption(&recordWithoutMAC)
	if err != nil {
		t.Fatal(err)
	}
	if err := verifyArchiveMAC(filename, macPassphrase, encryption); err != nil {
		t.Fatalf("an archive recorded without mac does not verify: %v", err)
	}
	if err := verifyArchiveMAC(filename, "wrong passphrase", withoutRecord); err == nil {
		t.Fatal("accepted wrong passphrase")
	}
	// The derived key needs the OpenSSL salt, which this archive does not have.
	if err := verifyArchiveMAC(filename, macPassphrase, currentArchiveEncryption); err == nil {
		t.Fatal("verified a raw-passphrase .hmac with the derived key")
	}
}
