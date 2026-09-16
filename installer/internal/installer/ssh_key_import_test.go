package installer

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func generatedAuthorizedKey(t *testing.T, algorithm string) (string, ssh.PublicKey, ssh.Signer) {
	t.Helper()
	var private any
	var err error
	switch algorithm {
	case "ed25519":
		_, private, err = ed25519.GenerateKey(rand.Reader)
	case "rsa2048":
		private, err = rsa.GenerateKey(rand.Reader, 2048)
	case "rsa3072":
		private, err = rsa.GenerateKey(rand.Reader, 3072)
	default:
		t.Fatalf("unknown test algorithm %q", algorithm)
	}
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey()))), signer.PublicKey(), signer
}

func TestSSHKeyImporterKeepsCompatibleEntriesAndClassifiesRestrictedOnes(t *testing.T) {
	var lines []string
	for index := 0; index < 21; index++ {
		key, _, _ := generatedAuthorizedKey(t, "ed25519")
		lines = append(lines, key+" user-comment")
	}
	restricted, _, _ := generatedAuthorizedKey(t, "ed25519")
	lines = append(lines, `from="192.0.2.0/24" `+restricted)
	path := filepath.Join(t.TempDir(), "authorized_keys")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	result, err := loadProxmoxAuthorizedKeys(proxmoxApplianceConfig{SSHKeysPath: path})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Accepted) != 21 || result.RejectedTotal() != 1 || result.Rejected[sshRejectOptioned] != 1 {
		t.Fatalf("unexpected safe import result: accepted=%d rejected=%v", len(result.Accepted), result.Rejected)
	}
	for _, accepted := range result.Accepted {
		if strings.Contains(accepted, "user-comment") || strings.Contains(accepted, "192.0.2.0") {
			t.Fatal("source comment or restricted option leaked into canonical answer key")
		}
	}
}

func TestSSHKeyClassifierDeduplicatesIdentityAndRejectsUnsafeForms(t *testing.T) {
	plain, publicKey, authority := generatedAuthorizedKey(t, "ed25519")
	weak, _, _ := generatedAuthorizedKey(t, "rsa2048")
	strong, _, _ := generatedAuthorizedKey(t, "rsa3072")
	certificate := &ssh.Certificate{
		Key: publicKey, Serial: 1, CertType: ssh.UserCert,
		ValidPrincipals: []string{"test"}, ValidAfter: 1, ValidBefore: ssh.CertTimeInfinity,
	}
	if err := certificate.SignCert(rand.Reader, authority); err != nil {
		t.Fatal(err)
	}
	certLine := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(certificate)))
	path := filepath.Join(t.TempDir(), "authorized_keys")
	contents := strings.Join([]string{
		plain + " first-comment",
		plain + " duplicate-comment",
		strong,
		weak,
		certLine,
		"-----BEGIN OPENSSH PRIVATE KEY-----",
		"not-a-public-key",
		plain + " trailing data that is not a comment",
	}, "\n")
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}

	result, err := loadProxmoxAuthorizedKeys(proxmoxApplianceConfig{SSHKeysPath: path})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Accepted) != 2 {
		t.Fatalf("accepted=%d, want deduplicated ED25519 and strong RSA", len(result.Accepted))
	}
	for rejection, want := range map[sshKeyRejection]int{
		sshRejectWeakRSA: 1, sshRejectCertificate: 1, sshRejectPrivate: 1, sshRejectMalformed: 1,
	} {
		if result.Rejected[rejection] != want {
			t.Fatalf("rejection %s=%d, want %d (all=%v)", rejection, result.Rejected[rejection], want, result.Rejected)
		}
	}
	if result.RejectedTotal() != 4 {
		t.Fatalf("unexpected rejection total: %v", result.Rejected)
	}
	if canonical, _, rejection := classifySSHAuthorizedKey(plain); canonical == "" || rejection != "" {
		t.Fatalf("plain public key rejected: %s", rejection)
	}
}

func TestSSHKeyImporterTreatsExplicitUnreadablePathAsFatal(t *testing.T) {
	_, err := loadProxmoxAuthorizedKeys(proxmoxApplianceConfig{SSHKeysPath: filepath.Join(t.TempDir(), "missing")})
	if err == nil || !strings.Contains(err.Error(), "read SSH public keys") {
		t.Fatalf("explicit missing path was not fatal: %v", err)
	}
}
