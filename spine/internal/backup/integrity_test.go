package backup

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAuthenticatedArchiveRejectsWrongPassphraseAndMutation(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "backup.tar.enc")
	if err := os.WriteFile(filename, []byte("encrypted archive bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := writeArchiveMAC(filename, "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	if err := verifyArchiveMAC(filename, "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	if err := verifyArchiveMAC(filename, "wrong passphrase"); err == nil {
		t.Fatal("accepted wrong passphrase")
	}
	if err := os.WriteFile(filename, []byte("mutated archive bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := verifyArchiveMAC(filename, "correct horse battery staple"); err == nil {
		t.Fatal("accepted mutated ciphertext")
	}
}
