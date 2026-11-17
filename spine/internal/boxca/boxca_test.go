package boxca

import (
	"crypto/x509"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestEnsureCreatesAndReusesRoot(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "tls")
	now := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	first, err := Ensure(dir, now)
	if err != nil {
		t.Fatal(err)
	}
	if !first.Cert.IsCA || first.Cert.NotAfter.Sub(now) < 9*365*24*time.Hour {
		t.Fatalf("root is not a long-lived CA: %+v", first.Cert.NotAfter)
	}
	for _, name := range []string{"root.crt", "root.key"} {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("%s mode = %v, %v", name, info.Mode(), err)
		}
	}
	second, err := Ensure(dir, now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if !second.Cert.Equal(first.Cert) {
		t.Fatal("Ensure replaced a usable root")
	}
}

func TestEnsureReplacesBrokenRoot(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "root.crt"), []byte("junk"), 0600); err != nil {
		t.Fatal(err)
	}
	root, err := Ensure(dir, time.Now())
	if err != nil || root == nil {
		t.Fatalf("Ensure = %v", err)
	}
}

func TestLeafChainsToRoot(t *testing.T) {
	now := time.Now()
	root, err := Ensure(t.TempDir(), now)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := root.Leaf([]string{"youeye.local", "192.168.31.24"}, now)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(root.Cert)
	for _, name := range []string{"youeye.local", "192.168.31.24"} {
		if _, err := leaf.Leaf.Verify(x509.VerifyOptions{DNSName: name, Roots: pool, CurrentTime: now}); err != nil {
			t.Fatalf("leaf does not verify for %s: %v", name, err)
		}
	}
	if leaf.Leaf.NotAfter.Sub(now) > LeafLifetime+time.Minute {
		t.Fatal("leaf lives too long")
	}
	if _, err := root.Leaf(nil, now); err == nil {
		t.Fatal("leaf without hosts accepted")
	}
}

func TestPlaceForCaddyOnlyWhenCaddyHasNoRoot(t *testing.T) {
	state := filepath.Join(t.TempDir(), "tls")
	caddy := t.TempDir()
	now := time.Now()
	placed, err := PlaceForCaddy(state, caddy, now)
	if err != nil || !placed {
		t.Fatalf("PlaceForCaddy = %v, %v", placed, err)
	}
	root, _ := Load(state)
	copied, err := Load(filepath.Join(caddy, CaddyAuthorityDir))
	if err != nil || !copied.Cert.Equal(root.Cert) {
		t.Fatalf("Caddy got a different root: %v", err)
	}
	if info, _ := os.Stat(filepath.Join(caddy, CaddyAuthorityDir, "root.key")); info.Mode().Perm() != 0600 {
		t.Fatalf("Caddy root key mode %v", info.Mode())
	}
	// A Caddy root that exists already (Caddy signed with it) stays.
	if err := os.WriteFile(filepath.Join(caddy, CaddyAuthorityDir, "root.crt"), []byte("caddy's own"), 0644); err != nil {
		t.Fatal(err)
	}
	placed, err = PlaceForCaddy(state, caddy, now)
	if err != nil || placed {
		t.Fatalf("existing Caddy root replaced: %v, %v", placed, err)
	}
}
