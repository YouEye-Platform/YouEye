package updatetrust

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
)

func TestOwnerGrantsRemainSourceChannelAndScopeBound(t *testing.T) {
	key, _, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(key)
	grant := Grant{Publisher: "Personal", Repository: "https://forge.example/alice/YouEye", Branch: "dev", Scope: "app", PublicKey: string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))}
	p := Policy{Schema: Schema, Grants: []Grant{grant}}
	path := filepath.Join(t.TempDir(), "trust.json")
	if err := Save(path, p); err != nil {
		t.Fatal(err)
	}
	p, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, scope := range []string{"appliance", "spine", "cp", "ui"} {
		if g, err := p.Lookup(grant.Repository, "dev", scope); err != nil || g != nil {
			t.Fatal("app key gained system authority")
		}
	}
	if g, _ := p.Lookup(grant.Repository, "main", "app"); g != nil {
		t.Fatal("cross-channel authority")
	}
	if g, _ := p.Lookup("https://forge.example/bob/YouEye", "dev", "app"); g != nil {
		t.Fatal("cross-repository authority")
	}
	if g, err := p.Lookup(grant.Repository, "dev", "app"); g == nil || err != nil {
		t.Fatal("exact owner grant refused")
	}
	p.Grants[0].Revoked = true
	if _, err := p.Lookup(grant.Repository, "dev", "app"); err == nil {
		t.Fatal("revoked grant fell back")
	}
	if err := os.WriteFile(path, []byte(`{"schema":"invalid","grants":[]}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("corrupt policy became empty trust")
	}
}
func TestReleaseIdentityRejectsAmbiguity(t *testing.T) {
	for _, raw := range []string{"https://forge.example/alice/YouEye/releases/download/cp-dev-v1.2/standalone.tar?token=x", "https://user@forge.example/alice/YouEye/releases/download/cp-dev-v1.2/standalone.tar", "http://forge.example/alice/YouEye/releases/download/cp-dev-v1.2/standalone.tar", "https://forge.example/alice/YouEye%2fother/releases/download/cp-dev-v1.2/standalone.tar"} {
		if _, _, _, err := ReleaseIdentity(raw); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	repo, branch, scope, err := ReleaseIdentity("https://forge.example/alice/YouEye/releases/download/cp-dev-v1.2/standalone.tar")
	if err != nil || repo != "https://forge.example/alice/YouEye" || branch != "dev" || scope != "cp" {
		t.Fatal(repo, branch, scope, err)
	}
}
