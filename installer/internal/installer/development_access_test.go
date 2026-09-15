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

func TestBuildDevelopmentAccessPolicySeparatesConsoleAndPasswordSSH(t *testing.T) {
	consoleOnly, err := buildDevelopmentAccessPolicy(false, "a long local test passphrase", "a long local test passphrase", developmentAccessPolicy{})
	if err != nil {
		t.Fatal(err)
	}
	if !consoleOnly.LocalRootConsole || consoleOnly.RootPasswordSSH || consoleOnly.SSHNetworkScope != "" || !validYescryptHash(consoleOnly.PasswordHash) {
		t.Fatalf("unexpected console-only policy: %+v", consoleOnly)
	}
	sshEnabled, err := buildDevelopmentAccessPolicy(true, "another long test passphrase", "another long test passphrase", developmentAccessPolicy{})
	if err != nil {
		t.Fatal(err)
	}
	if !sshEnabled.LocalRootConsole || !sshEnabled.RootPasswordSSH || sshEnabled.SSHNetworkScope != "local-subnet" {
		t.Fatalf("unexpected SSH policy: %+v", sshEnabled)
	}
	consoleRetained, err := buildDevelopmentAccessPolicy(false, "", "", sshEnabled)
	if err != nil || consoleRetained.PasswordHash == "" || !consoleRetained.LocalRootConsole || consoleRetained.RootPasswordSSH {
		t.Fatalf("local console credential was not retained: policy=%+v err=%v", consoleRetained, err)
	}
}
