package installer

import (
	"crypto/rsa"
	"encoding/base64"
	"fmt"
	"os"
	"strings"

	"golang.org/x/crypto/ssh"
)

type sshKeyRejection string

const (
	sshRejectOptioned    sshKeyRejection = "optioned"
	sshRejectCertificate sshKeyRejection = "certificate"
	sshRejectWeakRSA     sshKeyRejection = "weak-rsa"
	sshRejectMalformed   sshKeyRejection = "malformed"
	sshRejectPrivate     sshKeyRejection = "private-key"
	sshRejectUnsupported sshKeyRejection = "unsupported"
	sshRejectTrailing    sshKeyRejection = "trailing-data"
)

// sshKeyImportResult intentionally contains only canonical public keys and
// aggregate rejection counts. Comments and rejected source text must never
// reach answer media, progress, logs, or evidence.
type sshKeyImportResult struct {
	Accepted []string
	Rejected map[sshKeyRejection]int
	Sources  int
	Changed  bool
}

func (result sshKeyImportResult) RejectedTotal() int {
	total := 0
	for _, count := range result.Rejected {
		total += count
	}
	return total
}

func loadProxmoxAuthorizedKeys(config proxmoxApplianceConfig) (sshKeyImportResult, error) {
	var paths []struct {
		path     string
		optional bool
	}
	if config.ImportHostSSHKeys {
		paths = append(paths, struct {
			path     string
			optional bool
		}{path: "/root/.ssh/authorized_keys", optional: true})
	}
	if config.SSHKeysPath != "" {
		paths = append(paths, struct {
			path     string
			optional bool
		}{path: config.SSHKeysPath})
	}

	result := sshKeyImportResult{Rejected: make(map[sshKeyRejection]int)}
	seen := make(map[string]struct{})
	for _, source := range paths {
		raw, err := os.ReadFile(source.path)
		if err != nil {
			if source.optional && os.IsNotExist(err) {
				continue
			}
			return result, fmt.Errorf("read SSH public keys %s: %w", source.path, err)
		}
		result.Sources++
		for _, line := range strings.Split(string(raw), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			canonical, identity, rejection := classifySSHAuthorizedKey(line)
			if rejection != "" {
				result.Rejected[rejection]++
				continue
			}
			if _, duplicate := seen[identity]; duplicate {
				continue
			}
			seen[identity] = struct{}{}
			result.Accepted = append(result.Accepted, canonical)
		}
	}
	return result, nil
}

func classifySSHAuthorizedKey(value string) (canonical, identity string, rejection sshKeyRejection) {
	if strings.Contains(value, "PRIVATE KEY") {
		return "", "", sshRejectPrivate
	}
	publicKey, _, options, rest, err := ssh.ParseAuthorizedKey([]byte(value))
	if err != nil {
		return "", "", sshRejectMalformed
	}
	if len(options) != 0 {
		return "", "", sshRejectOptioned
	}
	if strings.TrimSpace(string(rest)) != "" {
		return "", "", sshRejectTrailing
	}
	if strings.Contains(publicKey.Type(), "-cert-") {
		return "", "", sshRejectCertificate
	}
	switch publicKey.Type() {
	case ssh.KeyAlgoED25519, "sk-ssh-ed25519@openssh.com",
		ssh.KeyAlgoECDSA256, ssh.KeyAlgoECDSA384, ssh.KeyAlgoECDSA521,
		"sk-ecdsa-sha2-nistp256@openssh.com":
	case ssh.KeyAlgoRSA:
		cryptoKey, ok := publicKey.(ssh.CryptoPublicKey)
		if !ok {
			return "", "", sshRejectUnsupported
		}
		rsaKey, ok := cryptoKey.CryptoPublicKey().(*rsa.PublicKey)
		if !ok {
			return "", "", sshRejectUnsupported
		}
		if rsaKey.N.BitLen() < 3072 {
			return "", "", sshRejectWeakRSA
		}
	default:
		return "", "", sshRejectUnsupported
	}
	canonical = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(publicKey)))
	identity = publicKey.Type() + ":" + base64.RawStdEncoding.EncodeToString(publicKey.Marshal())
	return canonical, identity, ""
}
