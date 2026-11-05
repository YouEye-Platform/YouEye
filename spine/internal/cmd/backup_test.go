package cmd

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadBackupPassphraseFileRequiresPrivateRegularFile(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "passphrase")
	if err := os.WriteFile(filename, []byte("correct horse battery staple\n"), 0600); err != nil {
		t.Fatal(err)
	}
	got, err := readPassphraseFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	if got != "correct horse battery staple" {
		t.Fatal("passphrase newline was not stripped exactly")
	}
	if err := os.Chmod(filename, 0640); err != nil {
		t.Fatal(err)
	}
	if _, err := readPassphraseFile(filename); err == nil {
		t.Fatal("accepted a group-readable passphrase file")
	}
}

func TestBackupPassphraseLengthBoundary(t *testing.T) {
	if err := validateBackupPassphrase("short"); err == nil {
		t.Fatal("accepted a short passphrase")
	}
	if err := validateBackupPassphrase("twelve-chars"); err != nil {
		t.Fatal(err)
	}
	if err := validateBackupPassphrase(string(make([]byte, 257))); err == nil {
		t.Fatal("accepted an oversized passphrase")
	}
}
