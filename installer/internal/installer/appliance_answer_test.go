package installer

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func TestParseApplianceAnswerSupportsDHCPAndStaticIPv4(t *testing.T) {
	for _, raw := range []string{
		`{"schema":"youeye.appliance.answer.v2","operation":"erase-install","transaction_id":"0123456789abcdef0123456789abcdef","target_serial":"TARGET","erase_confirmed":true,"network":{"mode":"dhcp"}}`,
		`{"schema":"youeye.appliance.answer.v3","operation":"erase-install","transaction_id":"0123456789abcdef0123456789abcdef","target_serial":"TARGET","erase_confirmed":true,"network":{"mode":"dhcp","adapter_mac":"02:00:00:00:00:18"},"release_policy":{"schema":"youeye.release-policy.v1","provider":"github","mode":"track","track":"stable","freshness":"require-current"},"development_access":{"schema":"youeye.development-access.v1","local_root_console":false,"root_password_ssh":false}}`,
		`{"schema":"youeye.appliance.answer.v2","operation":"erase-install","transaction_id":"0123456789abcdef0123456789abcdef","target_serial":"TARGET","erase_confirmed":true,"network":{"mode":"static","address":"192.0.2.10/24","gateway":"192.0.2.1","dns":"192.0.2.53"}}`,
	} {
		if _, err := parseApplianceAnswer([]byte(raw)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestValidateApplianceAuthorizedKeyPolicy(t *testing.T) {
	edPublic, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	edKey, err := ssh.NewPublicKey(edPublic)
	if err != nil {
		t.Fatal(err)
	}
	edAuthorized := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(edKey))) + " operator"
	if err := validateApplianceAuthorizedKey(edAuthorized); err != nil {
		t.Fatalf("Ed25519 key rejected: %v", err)
	}
	if err := validateApplianceAuthorizedKey("command=\"id\" " + edAuthorized); err == nil || !strings.Contains(err.Error(), "options") {
		t.Fatalf("authorized_keys options result = %v", err)
	}

	for bits, accepted := range map[int]bool{2048: false, 3072: true} {
		key, err := rsa.GenerateKey(rand.Reader, bits)
		if err != nil {
			t.Fatal(err)
		}
		public, err := ssh.NewPublicKey(&key.PublicKey)
		if err != nil {
			t.Fatal(err)
		}
		err = validateApplianceAuthorizedKey(string(ssh.MarshalAuthorizedKey(public)))
		if accepted && err != nil {
			t.Fatalf("%d-bit RSA key rejected: %v", bits, err)
		}
		if !accepted && err == nil {
			t.Fatalf("%d-bit RSA key accepted", bits)
		}
	}
}

func testApplianceAuthorizedKey(t *testing.T) string {
	t.Helper()
	public, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ssh.NewPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key))) + " tester"
}

func TestParseApplianceAnswerRejectsUnsafeOrAmbiguousInput(t *testing.T) {
	cases := map[string]string{
		"missing transaction":   `{"schema":"youeye.appliance.answer.v2","operation":"erase-install","target_serial":"TARGET","erase_confirmed":true,"network":{"mode":"dhcp"}}`,
		"IPv6 static":           `{"schema":"youeye.appliance.answer.v2","operation":"erase-install","transaction_id":"0123456789abcdef0123456789abcdef","target_serial":"TARGET","erase_confirmed":true,"network":{"mode":"static","address":"2001:db8::1/64","gateway":"192.0.2.1","dns":"192.0.2.53"}}`,
		"private key":           `{"schema":"youeye.appliance.answer.v2","operation":"erase-install","transaction_id":"0123456789abcdef0123456789abcdef","target_serial":"TARGET","erase_confirmed":true,"network":{"mode":"dhcp"},"authorized_keys":["-----BEGIN OPENSSH PRIVATE KEY-----"]}`,
		"unconfirmed erase":     `{"schema":"youeye.appliance.answer.v2","operation":"erase-install","transaction_id":"0123456789abcdef0123456789abcdef","target_serial":"TARGET","network":{"mode":"dhcp"}}`,
		"legacy typed phrase":   `{"schema":"youeye.appliance.answer.v1","operation":"reinstall","transaction_id":"0123456789abcdef0123456789abcdef","target_serial":"TARGET","allow_nonblank":true,"confirmation":"ERASE DEADBEEF","network":{"mode":"dhcp"}}`,
		"short transaction":     `{"schema":"youeye.appliance.answer.v2","operation":"erase-install","transaction_id":"0123","target_serial":"TARGET","erase_confirmed":true,"network":{"mode":"dhcp"}}`,
		"uppercase transaction": `{"schema":"youeye.appliance.answer.v2","operation":"erase-install","transaction_id":"0123456789ABCDEF0123456789ABCDEF","target_serial":"TARGET","erase_confirmed":true,"network":{"mode":"dhcp"}}`,
		"multicast adapter":     `{"schema":"youeye.appliance.answer.v2","operation":"erase-install","transaction_id":"0123456789abcdef0123456789abcdef","target_serial":"TARGET","erase_confirmed":true,"network":{"mode":"dhcp","adapter_mac":"01:00:5e:00:00:01"}}`,
		"noncanonical adapter":  `{"schema":"youeye.appliance.answer.v2","operation":"erase-install","transaction_id":"0123456789abcdef0123456789abcdef","target_serial":"TARGET","erase_confirmed":true,"network":{"mode":"dhcp","adapter_mac":"02-00-00-00-00-18"}}`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := parseApplianceAnswer([]byte(raw)); err == nil {
				t.Fatal("expected rejection")
			}
		})
	}
}

func TestParseApplianceAnswerRejectsTrailingJSON(t *testing.T) {
	raw := `{"schema":"youeye.appliance.answer.v2","operation":"erase-install","transaction_id":"0123456789abcdef0123456789abcdef","target_serial":"TARGET","erase_confirmed":true,"network":{"mode":"dhcp"}} {}`
	if _, err := parseApplianceAnswer([]byte(raw)); err == nil || !strings.Contains(err.Error(), "trailing") {
		t.Fatalf("expected trailing JSON rejection, got %v", err)
	}
}

func TestApplianceAnswerAcceptsPreserveReinstallWithoutEraseConfirmation(t *testing.T) {
	raw := []byte(`{"schema":"youeye.appliance.answer.v2","operation":"preserve-reinstall","transaction_id":"0123456789abcdef0123456789abcdef","target_serial":"disk-1","network":{"mode":"dhcp"}}`)
	answer, err := parseApplianceAnswer(raw)
	if err != nil {
		t.Fatal(err)
	}
	if answer.Operation != "preserve-reinstall" || answer.EraseConfirmed {
		t.Fatalf("unexpected preserve answer: %+v", answer)
	}
}

func TestCandidateCacheAnswerRequiresVersionedHash(t *testing.T) {
	raw := `{"schema":"youeye.appliance.answer.v3","operation":"erase-install","transaction_id":"0123456789abcdef0123456789abcdef","target_serial":"TARGET","erase_confirmed":true,"network":{"mode":"dhcp"},"release_policy":{"schema":"youeye.release-policy.v1","provider":"github","mode":"track","track":"stable","freshness":"require-current"},"development_access":{"schema":"youeye.development-access.v1","local_root_console":false,"root_password_ssh":false},"release_cache_sha256":"` + strings.Repeat("a", 64) + `"}`
	if _, err := parseApplianceAnswer([]byte(raw)); err == nil {
		t.Fatal("legacy schema accepted cache transport")
	}
	raw = strings.Replace(raw, "answer.v3", "answer.v4", 1)
	if _, err := parseApplianceAnswer([]byte(raw)); err != nil {
		t.Fatal(err)
	}
	raw = strings.Replace(raw, strings.Repeat("a", 64), "../untrusted", 1)
	if _, err := parseApplianceAnswer([]byte(raw)); err == nil {
		t.Fatal("invalid cache digest accepted")
	}
}
