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
	"strings"

	"github.com/youeye-platform/YouEye/releasecache"
	"golang.org/x/crypto/ssh"
)

const (
	applianceAnswerSchema = "youeye.appliance.answer.v1"
	releasePolicySchema   = "youeye.release-policy.v1"
	consoleAccessSchema   = "youeye.console-access.v1"
)

type applianceAnswer struct {
	CoreRelease        *coreAnswerSelection   `json:"core_release,omitempty"`
	ReleaseCacheSHA256 string                 `json:"release_cache_sha256,omitempty"`
	Schema             string                 `json:"schema"`
	Operation          string                 `json:"operation"`
	TransactionID      string                 `json:"transaction_id,omitempty"`
	TargetSerial       string                 `json:"target_serial,omitempty"`
	EraseConfirmed     bool                   `json:"erase_confirmed,omitempty"`
	Network            applianceAnswerNetwork `json:"network"`
	ReleasePolicy      applianceReleasePolicy `json:"release_policy,omitempty"`
	ConsoleAccess      consoleAccessPolicy    `json:"console_access"`
	AuthorizedKeys     []string               `json:"authorized_keys,omitempty"`
}

type applianceAnswerNetwork struct {
	Mode       string `json:"mode"`
	AdapterMAC string `json:"adapter_mac,omitempty"`
	Address    string `json:"address,omitempty"`
	Gateway    string `json:"gateway,omitempty"`
	DNS        string `json:"dns,omitempty"`
}

// applianceReleasePolicy is persisted on YE-STATE (release-policy.json). The
// box follows Channel of Repository; the repository never changes after
// installation. CoreManifestSHA256 is the root of trust.
type applianceReleasePolicy struct {
	Schema             string `json:"schema"`
	Repository         string `json:"repository"`
	Channel            string `json:"channel"`
	CoreManifestSHA256 string `json:"core_manifest_sha256,omitempty"`
	ServiceSelection   string `json:"service_selection,omitempty"`
}

// consoleAccessPolicy is what the installer writes to State as
// bootstrap/console-access.json (with an empty account list): an optional
// root password (yescrypt) and opt-in password SSH from the local subnet.
// Spine owns the record afterwards and adds the admins' accounts.
type consoleAccessPolicy struct {
	Schema           string `json:"schema"`
	RootPasswordHash string `json:"root_password_hash,omitempty"`
	PasswordSSH      bool   `json:"password_ssh"`
}

func defaultApplianceReleasePolicy() applianceReleasePolicy {
	return applianceReleasePolicy{Schema: releasePolicySchema, Repository: releasecache.OfficialRepository, Channel: "stable"}
}

func defaultConsoleAccessPolicy() consoleAccessPolicy {
	return consoleAccessPolicy{Schema: consoleAccessSchema}
}

func parseApplianceAnswer(raw []byte) (applianceAnswer, error) {
	var answer applianceAnswer
	if len(raw) > 18<<20 {
		return answer, fmt.Errorf("appliance answer exceeds bounded selection limit")
	}
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
	if answer.Schema != applianceAnswerSchema {
		return fmt.Errorf("unsupported appliance answer schema %q", answer.Schema)
	}
	if answer.Operation != "erase-install" && answer.Operation != "preserve-reinstall" && answer.Operation != "resume" && answer.Operation != "cancel" {
		return fmt.Errorf("unsupported appliance answer operation %q", answer.Operation)
	}
	if answer.ReleaseCacheSHA256 != "" && !validSHA256Hex(answer.ReleaseCacheSHA256) {
		return fmt.Errorf("release cache requires an exact digest")
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
	if err := validateApplianceReleasePolicy(answer.ReleasePolicy); err != nil {
		return err
	}
	if err := validateConsoleAccessPolicy(answer.ConsoleAccess); err != nil {
		return err
	}
	if answer.CoreRelease != nil || answer.ReleasePolicy.CoreManifestSHA256 != "" {
		if err := validateCoreAnswer(answer); err != nil {
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
	if repository, err := releasecache.CanonicalRepository(policy.Repository); err != nil || repository != policy.Repository {
		return fmt.Errorf("release policy repository must be a canonical https://host/owner/repository URL")
	}
	if !releasecache.ValidChannel(policy.Channel) {
		return fmt.Errorf("release policy channel must be dev, alpha, beta or stable")
	}
	if policy.ServiceSelection != "" && policy.ServiceSelection != "sealed" && policy.ServiceSelection != "current" {
		return fmt.Errorf("service selection must be sealed or current")
	}
	if policy.CoreManifestSHA256 != "" && !validSHA256Hex(policy.CoreManifestSHA256) {
		return fmt.Errorf("core manifest digest must be exact lowercase SHA-256")
	}
	return nil
}

func validateConsoleAccessPolicy(policy consoleAccessPolicy) error {
	if policy.Schema != consoleAccessSchema {
		return fmt.Errorf("console access schema must be %s", consoleAccessSchema)
	}
	if policy.RootPasswordHash != "" && !validYescryptHash(policy.RootPasswordHash) {
		return fmt.Errorf("console access root password must be a valid yescrypt hash")
	}
	if policy.PasswordSSH && policy.RootPasswordHash == "" {
		return fmt.Errorf("password SSH needs a root password here; admins can turn it on later in the Control Panel")
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
