package remoteaccess

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func testPublicKey(t *testing.T, bits int, comment string) string {
	t.Helper()
	var public any
	if bits == 0 {
		key, _, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		public = key
	} else {
		key, err := rsa.GenerateKey(rand.Reader, bits)
		if err != nil {
			t.Fatal(err)
		}
		public = &key.PublicKey
	}
	key, err := ssh.NewPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key))) + " " + comment
}

func testManager(t *testing.T) *Manager {
	t.Helper()
	dir := t.TempDir()
	return &Manager{
		StorePath: filepath.Join(dir, "state", "authorized-keys.json"),
		AuditPath: filepath.Join(dir, "state", "audit.jsonl"),
		LivePath:  filepath.Join(dir, "root", ".ssh", "authorized_keys"),
		Now:       func() time.Time { return time.Date(2026, 8, 9, 1, 2, 3, 0, time.UTC) },
	}
}

func TestParsePublicKeyPolicy(t *testing.T) {
	ed25519Key := testPublicKey(t, 0, "operator")
	parsed, err := ParsePublicKey(ed25519Key)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Type != ssh.KeyAlgoED25519 || parsed.Fingerprint == "" || parsed.Comment != "operator" {
		t.Fatalf("unexpected parsed key: %+v", parsed)
	}
	rsaKey := testPublicKey(t, 3072, "rsa")
	parsed, err = ParsePublicKey(rsaKey)
	if err != nil || parsed.Bits != 3072 {
		t.Fatalf("3072-bit RSA rejected: %+v %v", parsed, err)
	}
	weak := []struct {
		name string
		key  string
	}{
		{"options", "from=\"10.0.0.0/8\" " + ed25519Key},
		{"multiple", ed25519Key + "\n" + ed25519Key},
		{"private", "-----BEGIN OPENSSH PRIVATE KEY-----"},
		{"small RSA", testPublicKey(t, 2048, "small")},
	}
	for _, test := range weak {
		t.Run(test.name, func(t *testing.T) {
			if _, err := ParsePublicKey(test.key); err == nil {
				t.Fatal("invalid key was accepted")
			}
		})
	}
}

func TestManagerImportsInstallerKeyAndPersistsMutations(t *testing.T) {
	manager := testManager(t)
	installerKey := testPublicKey(t, 0, "installer")
	if err := os.MkdirAll(filepath.Dir(manager.LivePath), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manager.LivePath, []byte(installerKey+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	keys, err := manager.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(keys) != 1 || keys[0].Source != "installer" {
		t.Fatalf("installer import = %+v", keys)
	}
	second, err := manager.Add(testPublicKey(t, 3072, "backup"), "settings")
	if err != nil {
		t.Fatal(err)
	}
	keys, err = manager.List()
	if err != nil || len(keys) != 2 {
		t.Fatalf("keys after add = %+v, %v", keys, err)
	}
	if _, err := manager.Delete(second.ID, false); err != nil {
		t.Fatal(err)
	}
	keys, _ = manager.List()
	if len(keys) != 1 {
		t.Fatalf("keys after delete = %+v", keys)
	}
	if _, err := manager.Delete(keys[0].ID, false); err == nil {
		t.Fatal("final-key delete did not require confirmation")
	}
	if _, err := manager.Delete(keys[0].ID, true); err != nil {
		t.Fatal(err)
	}
	live, err := os.ReadFile(manager.LivePath)
	if err != nil || len(live) != 0 {
		t.Fatalf("live authorized_keys = %q, %v", live, err)
	}
	storeInfo, err := os.Stat(manager.StorePath)
	if err != nil || storeInfo.Mode().Perm() != 0600 {
		t.Fatalf("store mode = %v, %v", storeInfo.Mode().Perm(), err)
	}
	audit, err := os.ReadFile(manager.AuditPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(audit), "public_key") || !strings.Contains(string(audit), `"action":"delete"`) {
		t.Fatalf("unexpected audit journal: %s", audit)
	}
}

func TestManagerReconcileRepairsLiveFileFromState(t *testing.T) {
	manager := testManager(t)
	key, err := manager.Add(testPublicKey(t, 0, "operator"), "cli")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manager.LivePath, []byte("corrupt\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := manager.Reconcile(); err != nil {
		t.Fatal(err)
	}
	live, err := os.ReadFile(manager.LivePath)
	if err != nil || strings.TrimSpace(string(live)) != key.PublicKey {
		t.Fatalf("reconciled live file = %q, %v", live, err)
	}
}

func TestManagerRejectsCorruptStoreInsteadOfTrustingLiveFile(t *testing.T) {
	manager := testManager(t)
	if err := os.MkdirAll(filepath.Dir(manager.StorePath), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manager.StorePath, []byte(`{"schema":"wrong","keys":[]}`), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := manager.List()
	if err == nil || errors.Is(err, os.ErrNotExist) {
		t.Fatalf("corrupt store result = %v", err)
	}
}
