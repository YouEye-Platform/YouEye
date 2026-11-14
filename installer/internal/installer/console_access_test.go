package installer

import (
	"bytes"
	"strings"
	"testing"

	yescrypt "github.com/openwall/yescrypt-go"
)

func TestHashRootPassphraseProducesVerifiableYescryptWithoutEmbeddingPlaintext(t *testing.T) {
	password := []byte("a long test passphrase")
	hash, err := hashRootPassphrase(password)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hash, "$y$j9T$") || strings.Contains(hash, string(password)) {
		t.Fatalf("unexpected yescrypt encoding")
	}
	verified, err := yescrypt.Hash(password, []byte(hash))
	if err != nil || string(verified) != hash {
		t.Fatalf("yescrypt verification failed: %v", err)
	}
	wipeBytes(password)
	if !bytes.Equal(password, make([]byte, len(password))) {
		t.Fatal("mutable password buffer was not cleared")
	}
}

func TestHashRootPassphraseAcceptsAnyNonEmptyValidLength(t *testing.T) {
	if _, err := hashRootPassphrase([]byte("x")); err != nil {
		t.Fatalf("one-character root password was rejected: %v", err)
	}
	for _, password := range [][]byte{nil, []byte("line break in password\n"), []byte{'x', 0}, bytes.Repeat([]byte("x"), 257)} {
		if _, err := hashRootPassphrase(password); err == nil {
			t.Fatalf("invalid password of length %d was accepted", len(password))
		}
	}
}

func TestBuildConsoleAccessDefaultsToLockedRoot(t *testing.T) {
	locked, err := buildConsoleAccess(false, true, "ignored password", "ignored password", consoleAccessPolicy{})
	if err != nil {
		t.Fatal(err)
	}
	if locked != defaultConsoleAccessPolicy() {
		t.Fatalf("without a root password the record must lock root and keep password SSH off: %+v", locked)
	}
	rootOnly, err := buildConsoleAccess(true, false, "a long local test passphrase", "a long local test passphrase", consoleAccessPolicy{})
	if err != nil {
		t.Fatal(err)
	}
	if rootOnly.PasswordSSH || !validYescryptHash(rootOnly.RootPasswordHash) || rootOnly.Schema != consoleAccessSchema {
		t.Fatalf("unexpected root-only record: %+v", rootOnly)
	}
	sshEnabled, err := buildConsoleAccess(true, true, "another long test passphrase", "another long test passphrase", consoleAccessPolicy{})
	if err != nil || !sshEnabled.PasswordSSH {
		t.Fatalf("unexpected SSH record: %+v err=%v", sshEnabled, err)
	}
	retained, err := buildConsoleAccess(true, false, "", "", sshEnabled)
	if err != nil || retained.RootPasswordHash != sshEnabled.RootPasswordHash || retained.PasswordSSH {
		t.Fatalf("root password was not retained: %+v err=%v", retained, err)
	}
	if _, err := buildConsoleAccess(true, false, "", "", consoleAccessPolicy{}); err == nil {
		t.Fatal("an empty root password was accepted")
	}
	if _, err := buildConsoleAccess(true, false, "one password", "another password", consoleAccessPolicy{}); err == nil {
		t.Fatal("mismatched root passwords were accepted")
	}
}

func TestValidateConsoleAccessPolicy(t *testing.T) {
	if err := validateConsoleAccessPolicy(consoleAccessPolicy{Schema: consoleAccessSchema, PasswordSSH: true}); err == nil {
		t.Fatal("password SSH without a root password was accepted")
	}
	if err := validateConsoleAccessPolicy(consoleAccessPolicy{Schema: consoleAccessSchema, RootPasswordHash: "plain"}); err == nil {
		t.Fatal("a non-yescrypt root password was accepted")
	}
	if err := validateConsoleAccessPolicy(consoleAccessPolicy{}); err == nil {
		t.Fatal("a record without its schema was accepted")
	}
}
