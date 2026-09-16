package installer

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rsa"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/url"
	"strings"

	"golang.org/x/crypto/ssh"
)

const (
	applianceAnswerSchema       = "youeye.appliance.answer.v3"
	applianceAnswerLegacySchema = "youeye.appliance.answer.v2"
	releasePolicySchema         = "youeye.release-policy.v1"
	developmentAccessSchema     = "youeye.development-access.v1"
)

type applianceAnswer struct {
	Schema         string                  `json:"schema"`
	Operation      string                  `json:"operation"`
	TransactionID  string                  `json:"transaction_id,omitempty"`
	TargetSerial   string                  `json:"target_serial,omitempty"`
	EraseConfirmed bool                    `json:"erase_confirmed,omitempty"`
	Network        applianceAnswerNetwork  `json:"network"`
	ReleasePolicy  applianceReleasePolicy  `json:"release_policy,omitempty"`
	Development    developmentAccessPolicy `json:"development_access,omitempty"`
	AuthorizedKeys []string                `json:"authorized_keys,omitempty"`
}

type applianceAnswerNetwork struct {
	Mode       string `json:"mode"`
	AdapterMAC string `json:"adapter_mac,omitempty"`
	Address    string `json:"address,omitempty"`
	Gateway    string `json:"gateway,omitempty"`
	DNS        string `json:"dns,omitempty"`
}

// applianceReleasePolicy is persisted on YE-STATE and consumed by the sealed
// first-boot bootstrap. A branch identifies a signed release track; it never
// authorizes a mutable branch archive or raw source checkout.
type applianceReleasePolicy struct {
	Schema         string `json:"schema"`
	Provider       string `json:"provider"`
	ReleasesAPI    string `json:"releases_api,omitempty"`
	Mode           string `json:"mode"`
	Track          string `json:"track,omitempty"`
	Branch         string `json:"branch,omitempty"`
	ExactTag       string `json:"exact_tag,omitempty"`
	ManifestSHA256 string `json:"manifest_sha256,omitempty"`
	Freshness      string `json:"freshness"`
}

type developmentAccessPolicy struct {
	Schema           string `json:"schema"`
	LocalRootConsole bool   `json:"local_root_console"`
	RootPasswordSSH  bool   `json:"root_password_ssh"`
	PasswordHash     string `json:"password_hash,omitempty"`
	SSHNetworkScope  string `json:"ssh_network_scope,omitempty"`
}

func defaultApplianceReleasePolicy() applianceReleasePolicy {
	return applianceReleasePolicy{
		Schema: releasePolicySchema, Provider: defaultApplianceProvider,
		Mode: "track", Track: "stable", Freshness: "require-current",
	}
}

func defaultDevelopmentAccessPolicy() developmentAccessPolicy {
	return developmentAccessPolicy{Schema: developmentAccessSchema}
}

func parseApplianceAnswer(raw []byte) (applianceAnswer, error) {
	var answer applianceAnswer
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&answer); err != nil {
		return answer, fmt.Errorf("decode appliance answer: %w", err)
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return answer, fmt.Errorf("decode appliance answer: trailing JSON value")
	}
	if err := validateApplianceAnswer(answer); err != nil {
		return answer, err
	}
	return answer, nil
}

func validateApplianceAnswer(answer applianceAnswer) error {
	if answer.Schema != applianceAnswerSchema && answer.Schema != applianceAnswerLegacySchema {
		return fmt.Errorf("unsupported appliance answer schema %q", answer.Schema)
	}
	if answer.Operation != "erase-install" && answer.Operation != "preserve-reinstall" && answer.Operation != "resume" && answer.Operation != "cancel" {
		return fmt.Errorf("unsupported appliance answer operation %q", answer.Operation)
	}
	if answer.Operation != "cancel" && !validApplianceTransactionID(answer.TransactionID) {
		return fmt.Errorf("appliance answer transaction_id must be 32 lowercase hexadecimal characters")
	}
	if answer.Operation != "cancel" && strings.TrimSpace(answer.TargetSerial) == "" {
		return fmt.Errorf("appliance answer target_serial is required")
	}
	if answer.Operation == "erase-install" && !answer.EraseConfirmed {
		return fmt.Errorf("appliance answer erase-install requires erase_confirmed")
	}
	if answer.Operation != "erase-install" && answer.EraseConfirmed {
		return fmt.Errorf("appliance answer erase_confirmed requires the erase-install operation")
	}
	if answer.Operation == "cancel" {
		return nil
	}
	if answer.Network.AdapterMAC != "" && !validEthernetMAC(answer.Network.AdapterMAC) {
		return fmt.Errorf("appliance answer adapter_mac must be a unicast Ethernet MAC address")
	}
	if answer.Schema == applianceAnswerSchema {
		if err := validateApplianceReleasePolicy(answer.ReleasePolicy); err != nil {
			return err
		}
		if err := validateDevelopmentAccessPolicy(answer.Development); err != nil {
			return err
		}
	}
	switch strings.ToLower(strings.TrimSpace(answer.Network.Mode)) {
	case "dhcp":
		if answer.Network.Address != "" || answer.Network.Gateway != "" {
			return fmt.Errorf("DHCP appliance answer cannot include a static address or gateway")
		}
	case "static":
		ip, _, err := net.ParseCIDR(answer.Network.Address)
		if err != nil || ip.To4() == nil {
			return fmt.Errorf("appliance answer static address must be IPv4 CIDR")
		}
		if ip := net.ParseIP(answer.Network.Gateway); ip == nil || ip.To4() == nil {
			return fmt.Errorf("appliance answer static gateway must be IPv4")
		}
		if ip := net.ParseIP(answer.Network.DNS); ip == nil || ip.To4() == nil {
			return fmt.Errorf("appliance answer static DNS must be IPv4")
		}
	default:
		return fmt.Errorf("appliance answer network mode must be dhcp or static")
	}
	for _, key := range answer.AuthorizedKeys {
		if err := validateApplianceAuthorizedKey(key); err != nil {
			return fmt.Errorf("appliance answer contains an invalid SSH public key: %w", err)
		}
	}
	return nil
}

func validEthernetMAC(value string) bool {
	hardware, err := net.ParseMAC(strings.TrimSpace(value))
	return err == nil && len(hardware) == 6 && hardware[0]&1 == 0 && !bytes.Equal(hardware, make(net.HardwareAddr, 6)) && hardware.String() == strings.ToLower(strings.TrimSpace(value))
}

func validateApplianceReleasePolicy(policy applianceReleasePolicy) error {
	if policy.Schema != releasePolicySchema {
		return fmt.Errorf("release policy schema must be %s", releasePolicySchema)
	}
	provider := strings.ToLower(strings.TrimSpace(policy.Provider))
	if provider != "github" && provider != "forgejo" && provider != "custom" {
		return fmt.Errorf("release policy provider must be github, forgejo, or custom")
	}
	api := strings.TrimSpace(policy.ReleasesAPI)
	if provider == defaultApplianceProvider {
		if api != "" && api != defaultApplianceReleasesAPI {
			return fmt.Errorf("Official GitHub release policy uses the fixed public releases API")
		}
	} else {
		parsed, err := url.Parse(api)
		if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
			return fmt.Errorf("non-default release policy requires an HTTPS releases API without credentials, query, or fragment")
		}
	}
	if policy.Freshness != "require-current" && policy.Freshness != "prefer-current" {
		return fmt.Errorf("release policy freshness must be require-current or prefer-current")
	}
	switch policy.Mode {
	case "track":
		if policy.ExactTag != "" || policy.ManifestSHA256 != "" {
			return fmt.Errorf("tracking release policy cannot include an exact identity")
		}
		switch policy.Track {
		case "stable", "development":
			if policy.Branch != "" {
				return fmt.Errorf("stable and development release tracks cannot include a branch")
			}
		case "branch":
			if !validApplianceReleaseBranch(policy.Branch) {
				return fmt.Errorf("branch-associated release policy requires a safe branch name")
			}
		default:
			return fmt.Errorf("release policy track must be stable, development, or branch")
		}
	case "exact":
		if policy.Track != "" || policy.Branch != "" || !validExactApplianceReleaseTag(policy.ExactTag) || !validSHA256Hex(policy.ManifestSHA256) {
			return fmt.Errorf("exact release policy requires an appliance tag and lowercase manifest SHA-256")
		}
	default:
		return fmt.Errorf("release policy mode must be track or exact")
	}
	return nil
}

func validateDevelopmentAccessPolicy(policy developmentAccessPolicy) error {
	if policy.Schema != developmentAccessSchema {
		return fmt.Errorf("development access schema must be %s", developmentAccessSchema)
	}
	if !policy.LocalRootConsole && !policy.RootPasswordSSH {
		if policy.PasswordHash != "" || policy.SSHNetworkScope != "" {
			return fmt.Errorf("disabled development access cannot retain a password hash or SSH scope")
		}
		return nil
	}
	if !validYescryptHash(policy.PasswordHash) {
		return fmt.Errorf("enabled development access requires a valid yescrypt password hash")
	}
	if policy.RootPasswordSSH {
		if policy.SSHNetworkScope != "local-subnet" {
			return fmt.Errorf("root password SSH must be limited to the local subnet")
		}
	} else if policy.SSHNetworkScope != "" {
		return fmt.Errorf("SSH network scope requires root password SSH")
	}
	return nil
}

func validYescryptHash(value string) bool {
	if len(value) < 20 || len(value) > 512 || !strings.HasPrefix(value, "$y$") || strings.ContainsAny(value, "\r\n\x00") {
		return false
	}
	parts := strings.Split(value, "$")
	return len(parts) == 5 && parts[1] == "y" && parts[2] != "" && parts[3] != "" && parts[4] != ""
}

func validExactApplianceReleaseTag(value string) bool {
	if !strings.HasPrefix(value, "appliance-") || len(value) > 180 || strings.ContainsAny(value, "\\%\x00") {
		return false
	}
	if _, ok := parseApplianceReleaseTag(value, "appliance-v"); ok {
		return true
	}
	if _, ok := parseApplianceReleaseTag(value, "appliance-dev-v"); ok {
		return true
	}
	marker := strings.LastIndex(value, "-v")
	if marker <= len("appliance-") {
		return false
	}
	branch := value[len("appliance-"):marker]
	_, versionOK := parseApplianceReleaseTag(value, "appliance-"+branch+"-v")
	return versionOK && validApplianceReleaseBranch(branch)
}

func validateApplianceAuthorizedKey(value string) error {
	value = strings.TrimSpace(value)
	if value == "" || strings.Contains(value, "PRIVATE KEY") {
		return fmt.Errorf("a public key is required")
	}
	publicKey, _, options, rest, err := ssh.ParseAuthorizedKey([]byte(value))
	if err != nil {
		return fmt.Errorf("parse OpenSSH key: %w", err)
	}
	if len(options) != 0 {
		return fmt.Errorf("authorized_keys options are not accepted")
	}
	if strings.TrimSpace(string(rest)) != "" {
		return fmt.Errorf("provide exactly one public key per entry")
	}
	if strings.Contains(publicKey.Type(), "-cert-") {
		return fmt.Errorf("OpenSSH certificates are not accepted")
	}
	switch publicKey.Type() {
	case ssh.KeyAlgoED25519, "sk-ssh-ed25519@openssh.com",
		ssh.KeyAlgoECDSA256, ssh.KeyAlgoECDSA384, ssh.KeyAlgoECDSA521,
		"sk-ecdsa-sha2-nistp256@openssh.com":
		return nil
	case ssh.KeyAlgoRSA:
		cryptoKey, ok := publicKey.(ssh.CryptoPublicKey)
		if !ok {
			return fmt.Errorf("RSA key material is unavailable")
		}
		rsaKey, ok := cryptoKey.CryptoPublicKey().(*rsa.PublicKey)
		if !ok || rsaKey.N.BitLen() < 3072 {
			return fmt.Errorf("RSA keys must be at least 3072 bits")
		}
		return nil
	default:
		if cryptoKey, ok := publicKey.(ssh.CryptoPublicKey); ok {
			switch cryptoKey.CryptoPublicKey().(type) {
			case ed25519.PublicKey, *ecdsa.PublicKey:
				return nil
			}
		}
		return fmt.Errorf("key type %q is not supported", publicKey.Type())
	}
}

func validApplianceTransactionID(value string) bool {
	if len(value) != 32 || value != strings.ToLower(value) || strings.TrimSpace(value) != value {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}
