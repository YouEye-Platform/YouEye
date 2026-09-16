package cmd

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func validNamesBundleForTest(t *testing.T) []byte {
	t.Helper()
	name := "quiet-forest"
	fqdn := name + ".ui.bingo"
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	identityPKCS8, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		t.Fatal(err)
	}
	identityDigest := sha256.Sum256(public)

	tlsKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: fqdn},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(30 * 24 * time.Hour),
		DNSNames:     []string{fqdn, "*." + fqdn},
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	certificateDER, err := x509.CreateCertificate(rand.Reader, template, template, &tlsKey.PublicKey, tlsKey)
	if err != nil {
		t.Fatal(err)
	}
	tlsPKCS8, err := x509.MarshalPKCS8PrivateKey(tlsKey)
	if err != nil {
		t.Fatal(err)
	}
	certificateDigest := sha256.Sum256(certificateDER)
	bundle := namesBundleV3{
		SchemaVersion: 3,
		ExportedAt:    now.Format(time.RFC3339),
		Service: namesService{
			ID: "youeye-names-official", CanonicalOrigin: "https://names.youeye.me",
			APIVersion: "v1", ManagedZone: "ui.bingo",
		},
		Name: name,
		FQDN: fqdn,
		Identity: namesIdentity{
			Schema:        1,
			PrivateKeyPEM: string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: identityPKCS8})),
			PublicKeyRaw:  base64.RawURLEncoding.EncodeToString(public),
			Fingerprint:   base64.RawURLEncoding.EncodeToString(identityDigest[:]),
		},
		TLS: namesTLS{
			KeyPEM:  string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: tlsPKCS8})),
			CertPEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificateDER})),
		},
		Certificate: namesCertificate{
			Fingerprint: hex.EncodeToString(certificateDigest[:]),
			Provider:    nil,
			IssuedAt:    template.NotBefore.Format(time.RFC3339),
			ExpiresAt:   template.NotAfter.Format(time.RFC3339),
		},
		Consent: namesConsent{},
	}
	data, err := json.Marshal(bundle)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestValidateNamesBundleV3(t *testing.T) {
	bundle, err := validateNamesBundle(validNamesBundleForTest(t))
	if err != nil {
		t.Fatalf("valid bundle rejected: %v", err)
	}
	if bundle.Name != "quiet-forest" || bundle.FQDN != "quiet-forest.ui.bingo" {
		t.Fatalf("unexpected bundle identity: %#v", bundle)
	}
}

func TestValidateNamesBundleRejectsContractDriftAndMetadataMismatch(t *testing.T) {
	data := validNamesBundleForTest(t)
	var value map[string]interface{}
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	value["unexpected"] = true
	drifted, _ := json.Marshal(value)
	if _, err := validateNamesBundle(drifted); err == nil {
		t.Fatal("bundle with unknown top-level field was accepted")
	}
	delete(value, "unexpected")
	certificate := value["certificate"].(map[string]interface{})
	certificate["fingerprint"] = "00"
	mismatched, _ := json.Marshal(value)
	if _, err := validateNamesBundle(mismatched); err == nil {
		t.Fatal("bundle with mismatched certificate fingerprint was accepted")
	}
}

func TestReadProtectedBundleFileRejectsPublicModeAndSymlink(t *testing.T) {
	directory := t.TempDir()
	filename := filepath.Join(directory, "bundle.json")
	if err := os.WriteFile(filename, validNamesBundleForTest(t), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readProtectedBundleFile(filename); err == nil {
		t.Fatal("group/world-readable bundle was accepted")
	}
	if err := os.Chmod(filename, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readProtectedBundleFile(filename); err != nil {
		t.Fatalf("protected regular file rejected: %v", err)
	}
	link := filepath.Join(directory, "bundle-link.json")
	if err := os.Symlink(filename, link); err != nil {
		t.Fatal(err)
	}
	if _, err := readProtectedBundleFile(link); err == nil {
		t.Fatal("symlinked bundle was accepted")
	}
}

func TestWriteNewProtectedFileNeverOverwrites(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "bundle.json")
	if err := writeNewProtectedFile(filename, []byte("first")); err != nil {
		t.Fatal(err)
	}
	if mode := mustStat(t, filename).Mode().Perm(); mode != 0o600 {
		t.Fatalf("bundle mode = %04o", mode)
	}
	if err := writeNewProtectedFile(filename, []byte("second")); err == nil {
		t.Fatal("existing bundle was overwritten")
	}
	content, _ := os.ReadFile(filename)
	if string(content) != "first" {
		t.Fatalf("existing content changed to %q", content)
	}
}

func TestNamesCommandRequiresExplicitCredentialOutput(t *testing.T) {
	if namesExportCmd.Flags().Lookup("stdout") == nil || namesExportCmd.Flags().Lookup("output") == nil {
		t.Fatal("names export must expose explicit --output and --stdout choices")
	}
	if namesImportCmd.Flags().Lookup("replace") == nil {
		t.Fatal("names import must require an explicit staged-bundle replacement choice")
	}
}

func TestNamesImportCanExplicitlyRepairTheCurrentDomain(t *testing.T) {
	raw, err := os.ReadFile("names.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	if strings.Contains(source, "The server URL is already \" + bundle.FQDN + \" — nothing to do") {
		t.Fatal("same-domain recovery bundle is still discarded as a no-op")
	}
	if !strings.Contains(source, "state.Domain == bundle.FQDN && !namesImportYes") ||
		!strings.Contains(source, "re-apply its saved identity and certificate") {
		t.Fatal("same-domain recovery must require explicit --yes before re-applying protected authority")
	}
}

func TestUserPasswordSendsMatchingConfirmation(t *testing.T) {
	raw, err := os.ReadFile("user.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	if !strings.Contains(source, `"password":       password`) ||
		!strings.Contains(source, `"repeatPassword": password`) {
		t.Fatal("user password reset must satisfy the Control Panel confirmation contract")
	}
}

func TestUserCreateSupportsProtectedPasswordStdin(t *testing.T) {
	raw, err := os.ReadFile("user.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	if !strings.Contains(source, `"password-stdin"`) ||
		!strings.Contains(source, "repeatPassword = password") ||
		!strings.Contains(source, "scanner.Text()") {
		t.Fatal("user create must support a single protected stdin password and matching API confirmation")
	}
}

func mustStat(t *testing.T, filename string) os.FileInfo {
	t.Helper()
	info, err := os.Stat(filename)
	if err != nil {
		t.Fatal(err)
	}
	return info
}
