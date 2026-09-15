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
