package releases

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestVerifySignedReleaseArtifactUsesURLAssetNameForRenamedLocalFile(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	publicDER, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		t.Fatal(err)
	}
	trust := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicDER})
	previousTrust := releaseDevelopmentTrust
	releaseDevelopmentTrust = trust
	t.Cleanup(func() { releaseDevelopmentTrust = previousTrust })

	artifact := []byte("signed standalone release artifact")
	artifactDigest := sha256.Sum256(artifact)
	trustDigest := sha256.Sum256(trust)
	checksums := []byte(fmt.Sprintf(
		"%s  standalone.tar\n%s  release-development.pub\n%s  provenance.json\n%s  sbom.spdx.json\n",
		hex.EncodeToString(artifactDigest[:]),
		hex.EncodeToString(trustDigest[:]),
		strings.Repeat("1", sha256.Size*2),
		strings.Repeat("2", sha256.Size*2),
	))
	signature := ed25519.Sign(privateKey, checksums)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch filepath.Base(r.URL.Path) {
		case "release-development.pub":
			_, _ = w.Write(trust)
		case "SHA256SUMS":
			_, _ = w.Write(checksums)
		case "SHA256SUMS.sig":
			_, _ = w.Write(signature)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	localPath := filepath.Join(t.TempDir(), "control-panel.tar")
	if err := os.WriteFile(localPath, artifact, 0o600); err != nil {
		t.Fatal(err)
	}
	artifactURL := server.URL + "/youeye/YouEye/releases/download/cp-dev-v0.5.22.0.3/standalone.tar"
	if err := VerifySignedReleaseArtifact(server.Client(), artifactURL, localPath, hex.EncodeToString(artifactDigest[:])); err != nil {
		t.Fatalf("renamed local artifact failed signed verification: %v", err)
	}
}

func TestSignedReleaseArtifactNameRejectsInvalidFinalSegments(t *testing.T) {
	tests := []string{
		"https://forge.example.test/releases/download/tag/",
		"https://forge.example.test/releases/download/tag/%2Fstandalone.tar",
		"https://forge.example.test/releases/download/tag/nested%2Fstandalone.tar",
		"https://forge.example.test/releases/download/tag/nested%5Cstandalone.tar",
		"https://forge.example.test/releases/download/tag/..",
		"https://forge.example.test/releases/download/tag/%20standalone.tar",
	}
	for _, raw := range tests {
		artifact, err := url.Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		if got, err := signedReleaseArtifactName(artifact); err == nil {
			t.Fatalf("invalid artifact URL %q produced asset name %q", raw, got)
		}
	}
}

func TestSignedReleaseSiblingURLPreservesEncodedMultisegmentTag(t *testing.T) {
	artifact, err := url.Parse("https://forge.example.test/acme/YouEye/releases/download/cp-codex%2Fphase1-repository-builds-v1.2.3/standalone.tar")
	if err != nil {
		t.Fatal(err)
	}
	got, err := signedReleaseSiblingURL(artifact, "release-development.pub")
	if err != nil {
		t.Fatal(err)
	}
	want := "https://forge.example.test/acme/YouEye/releases/download/cp-codex%2Fphase1-repository-builds-v1.2.3/release-development.pub"
	if got != want {
		t.Fatalf("sibling URL = %q, want %q", got, want)
	}
}

func TestSignedReleaseSiblingURLRejectsNestedAsset(t *testing.T) {
	artifact, err := url.Parse("https://forge.example.test/acme/YouEye/releases/download/cp-main-v1.2.3/standalone.tar")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := signedReleaseSiblingURL(artifact, "nested/release-development.pub"); err == nil {
		t.Fatal("nested release metadata asset was accepted")
	}
}

func TestPublicComponentTrustIsChannelBound(t *testing.T) {
	previous := componentPublicTrustAnchor
	t.Cleanup(func() { componentPublicTrustAnchor = previous })
	componentPublicTrustAnchor = func(class string) ([]byte, error) { return []byte(class), nil }
	for _, tc := range []struct{ tag, class string }{{"cp-v0.5.25", "stable"}, {"ui-beta-v0.5.5", "beta"}} {
		u, _ := url.Parse("https://github.com/YouEye-Platform/YouEye/releases/download/" + tc.tag + "/standalone.tar")
		name, anchor, err := componentReleaseTrust(u)
		if err != nil || name != "release-public.pub" || string(anchor) != tc.class {
			t.Fatalf("name=%q anchor=%q error=%v", name, anchor, err)
		}
	}
	for _, raw := range []string{
		"http://github.com/a/b/releases/download/cp-v1.0.0/standalone.tar",
		"https://github.com:8443/a/b/releases/download/cp-v1.0.0/standalone.tar",
		"https://github.com/a/b/releases/download/cp-dev-v1.0.0/standalone.tar",
		"https://github.com/a/b/releases/download/cp-v1.0.0/standalone.tar?token=x",
	} {
		u, _ := url.Parse(raw)
		if _, _, err := componentReleaseTrust(u); err == nil {
			t.Fatalf("accepted invalid public source %s", raw)
		}
	}
	componentPublicTrustAnchor = func(string) ([]byte, error) { return nil, fmt.Errorf("unprovisioned") }
	u, _ := url.Parse("https://github.com/a/b/releases/download/cp-v1.0.0/standalone.tar")
	if _, _, err := componentReleaseTrust(u); err == nil {
		t.Fatal("missing public authority fell back to development")
	}
}

type publicSignatureTransport func(*http.Request) (*http.Response, error)

func (f publicSignatureTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestPublicComponentSignatureUsesProvisionedKey(t *testing.T) {
	publicKey, privateKey, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(publicKey)
	trust := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
	previous := componentPublicTrustAnchor
	t.Cleanup(func() { componentPublicTrustAnchor = previous })
	componentPublicTrustAnchor = func(class string) ([]byte, error) {
		if class != "stable" {
			return nil, fmt.Errorf("wrong channel")
		}
		return trust, nil
	}
	artifact := []byte("signed public artifact")
	artifactDigest := sha256.Sum256(artifact)
	trustDigest := sha256.Sum256(trust)
	sums := []byte(fmt.Sprintf("%x  standalone.tar\n%x  release-public.pub\n%s  provenance.json\n%s  sbom.spdx.json\n", artifactDigest, trustDigest, strings.Repeat("1", 64), strings.Repeat("2", 64)))
	sig := ed25519.Sign(privateKey, sums)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch filepath.Base(r.URL.Path) {
		case "release-public.pub":
			w.Write(trust)
		case "SHA256SUMS":
			w.Write(sums)
		case "SHA256SUMS.sig":
			w.Write(sig)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	upstream, _ := url.Parse(server.URL)
	client := &http.Client{Transport: publicSignatureTransport(func(r *http.Request) (*http.Response, error) {
		clone := r.Clone(r.Context())
		u := *r.URL
		u.Scheme = upstream.Scheme
		u.Host = upstream.Host
		clone.URL = &u
		return http.DefaultTransport.RoundTrip(clone)
	})}
	local := filepath.Join(t.TempDir(), "artifact")
	os.WriteFile(local, artifact, 0600)
	remote := "https://github.com/a/b/releases/download/cp-v1.0.0/standalone.tar"
	if err := VerifySignedReleaseArtifact(client, remote, local, fmt.Sprintf("%x", artifactDigest)); err != nil {
		t.Fatal(err)
	}
	sig[0] ^= 1
	if err := VerifySignedReleaseArtifact(client, remote, local, fmt.Sprintf("%x", artifactDigest)); err == nil {
		t.Fatal("invalid public signature accepted")
	}
}
