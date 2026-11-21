package backup

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const testPassphrase = "correct horse battery"

func requireOpenSSL(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("openssl"); err != nil {
		t.Skip("openssl is not installed")
	}
}

func run(t *testing.T, cmd *exec.Cmd) error {
	t.Helper()
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, output)
	}
	return nil
}

// Every parameter goes to OpenSSL, so its defaults never decide how an archive is written or read. Up to 0.6.14 the
// iteration count and digest were OpenSSL's defaults, and nothing recorded them.
func TestArchiveEncryptionNamesEveryParameter(t *testing.T) {
	argv := strings.Join(encryptCommand(currentArchiveEncryption, testPassphrase, "in", "out").Args, " ")
	for _, want := range []string{"enc -aes-256-cbc -pbkdf2 -md sha256 -iter 10000 -salt", "-pass stdin"} {
		if !strings.Contains(argv, want) {
			t.Fatalf("encrypt argv %q lacks %q", argv, want)
		}
	}
	argv = strings.Join(decryptCommand(context.Background(), currentArchiveEncryption, testPassphrase, "in", "out").Args, " ")
	if !strings.Contains(argv, "enc -d -aes-256-cbc -pbkdf2 -md sha256 -iter 10000") {
		t.Fatalf("decrypt argv %q", argv)
	}
	if strings.Contains(argv, testPassphrase) {
		t.Fatal("the passphrase is on the command line")
	}
}

// An archive written by 0.6.14 (`enc -aes-256-cbc -salt -pbkdf2`, no record in backup-set.json) restores.
func TestArchiveFromBeforeTheRecordStillRestores(t *testing.T) {
	requireOpenSSL(t)
	dir := t.TempDir()
	plain, archive, restored := filepath.Join(dir, "plain"), filepath.Join(dir, "archive"), filepath.Join(dir, "restored")
	if err := os.WriteFile(plain, []byte("backup contents\n"), 0600); err != nil {
		t.Fatal(err)
	}
	old := opensslWithPassphrase(testPassphrase, "enc", "-aes-256-cbc", "-salt", "-pbkdf2", "-in", plain, "-out", archive)
	if err := run(t, old); err != nil {
		t.Fatalf("0.6.14 encryption: %v", err)
	}
	encryption, err := restoreEncryption(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := run(t, decryptCommand(context.Background(), encryption, testPassphrase, archive, restored)); err != nil {
		t.Fatalf("a 0.6.14 archive does not restore: %v", err)
	}
	if got, _ := os.ReadFile(restored); string(got) != "backup contents\n" {
		t.Fatalf("restored %q", got)
	}
}

// A restore decrypts with the recorded parameters, so a later release can change them and still read every set.
func TestRestoreUsesTheRecordedParameters(t *testing.T) {
	requireOpenSSL(t)
	dir := t.TempDir()
	plain, archive := filepath.Join(dir, "plain"), filepath.Join(dir, "archive")
	if err := os.WriteFile(plain, []byte("backup contents\n"), 0600); err != nil {
		t.Fatal(err)
	}
	recorded := currentArchiveEncryption
	recorded.Iterations = 20000
	if err := run(t, encryptCommand(recorded, testPassphrase, plain, archive)); err != nil {
		t.Fatal(err)
	}
	withoutRecord, _ := restoreEncryption(nil)
	if run(t, decryptCommand(context.Background(), withoutRecord, testPassphrase, archive, filepath.Join(dir, "a"))) == nil {
		t.Fatal("decrypting with other parameters must fail")
	}
	encryption, err := restoreEncryption(&recorded)
	if err != nil {
		t.Fatal(err)
	}
	if err := run(t, decryptCommand(context.Background(), encryption, testPassphrase, archive, filepath.Join(dir, "b"))); err != nil {
		t.Fatalf("the recorded parameters do not decrypt: %v", err)
	}
}

func TestRestoreRefusesEncryptionItCannotRead(t *testing.T) {
	for _, recorded := range []ArchiveEncryption{
		{Cipher: "aes-256-gcm", KDF: "pbkdf2", Digest: "sha256", Iterations: 10000},
		{Cipher: "aes-256-cbc", KDF: "argon2id", Digest: "sha256", Iterations: 10000},
		{Cipher: "aes-256-cbc", KDF: "pbkdf2", Digest: "md5", Iterations: 10000},
		{Cipher: "aes-256-cbc", KDF: "pbkdf2", Digest: "sha256", Iterations: 1},
		{Cipher: "aes-256-cbc", KDF: "pbkdf2", Digest: "sha256", Iterations: 100_000_000},
		{Cipher: "aes-256-cbc", KDF: "pbkdf2", Digest: "sha256", Iterations: 10000, MAC: "hmac-sha256-argon2"},
	} {
		if _, err := restoreEncryption(&recorded); err == nil {
			t.Fatalf("accepted %+v", recorded)
		}
	}
	// A recorded cipher is passed to OpenSSL as an option: only the known one may get there.
	injected := ArchiveEncryption{Cipher: "aes-256-cbc -k x", KDF: "pbkdf2", Digest: "sha256", Iterations: 10000}
	if _, err := restoreEncryption(&injected); err == nil {
		t.Fatal("accepted an injected cipher")
	}
}

// A finished backup reports its encryption, which the Control Panel copies into backup-set.json.
func TestCompletedBackupReportsItsEncryption(t *testing.T) {
	old := statusDir
	statusDir = t.TempDir()
	t.Cleanup(func() { statusDir = old })
	Start("b1", []string{"encrypt"})
	Complete("b1", "/x/core.tar.enc", 42, currentArchiveEncryption)
	raw, err := os.ReadFile(statusPath())
	if err != nil {
		t.Fatal(err)
	}
	var status struct {
		Encryption map[string]interface{} `json:"encryption"`
	}
	if err := json.NewDecoder(bytes.NewReader(raw)).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if status.Encryption["cipher"] != "aes-256-cbc" || status.Encryption["kdf"] != "pbkdf2" ||
		status.Encryption["digest"] != "sha256" || status.Encryption["iterations"] != float64(10000) ||
		status.Encryption["mac"] != "hmac-sha256-pbkdf2" {
		t.Fatalf("status encryption %v", status.Encryption)
	}
}

// A real archive: OpenSSL writes the salt the .hmac key is derived with, and the whole file is authenticated.
func TestOpenSSLArchiveIsAuthenticatedWithItsSalt(t *testing.T) {
	requireOpenSSL(t)
	dir := t.TempDir()
	plain, archive := filepath.Join(dir, "plain"), filepath.Join(dir, "archive")
	if err := os.WriteFile(plain, []byte("backup contents\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := run(t, encryptCommand(currentArchiveEncryption, testPassphrase, plain, archive)); err != nil {
		t.Fatal(err)
	}
	if err := writeArchiveMAC(archive, testPassphrase, currentArchiveEncryption); err != nil {
		t.Fatal(err)
	}
	if err := verifyArchiveMAC(archive, testPassphrase, currentArchiveEncryption); err != nil {
		t.Fatal(err)
	}
	if err := verifyArchiveMAC(archive, "another passphrase", currentArchiveEncryption); err == nil {
		t.Fatal("accepted another passphrase")
	}
}
