package installer

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

type recordingLocalRunner struct {
	called int
	err    error
}

func (runner *recordingLocalRunner) Run(string) error {
	runner.called++
	return runner.err
}

func TestApplyLocalNetworkProfileValidatesAndRestoresSavedProfileOnFailure(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "network-profile.json")
	previous := localNetworkProfile{Schema: "youeye.network-profile.v1", ID: "primary", Kind: "ethernet", IPv4: localIPv4Profile{Mode: "dhcp"}}
	if err := writeProtectedJSON(path, previous); err != nil {
		t.Fatal(err)
	}
	candidate := localNetworkProfile{
		Schema: "youeye.network-profile.v1", ID: "primary", Kind: "ethernet", AdapterMAC: "02:00:00:00:00:18",
		IPv4: localIPv4Profile{Mode: "static", Address: "192.168.40.20/24", Gateway: "192.168.40.1", DNS: []string{"1.1.1.1"}},
	}
	runner := &recordingLocalRunner{err: errors.New("connectivity failed")}
	if err := applyLocalNetworkProfile(path, candidate, runner); err == nil || !strings.Contains(err.Error(), "saved profile was restored") {
		t.Fatalf("expected safe rollback error, got %v", err)
	}
	var restored localNetworkProfile
	raw, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(raw, &restored) != nil || restored.IPv4.Mode != "dhcp" {
		t.Fatalf("saved profile was not restored: profile=%+v err=%v", restored, err)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("network profile is not protected: %v", err)
	}
}

func TestValidateLocalNetworkProfileRejectsGatewayOutsideSubnetAndWiFi(t *testing.T) {
	for _, profile := range []localNetworkProfile{
		{Schema: "youeye.network-profile.v1", ID: "primary", Kind: "wifi", IPv4: localIPv4Profile{Mode: "dhcp"}},
		{Schema: "youeye.network-profile.v1", ID: "primary", Kind: "ethernet", AdapterMAC: "01:00:5e:00:00:01", IPv4: localIPv4Profile{Mode: "dhcp"}},
		{Schema: "youeye.network-profile.v1", ID: "primary", Kind: "ethernet", IPv4: localIPv4Profile{Mode: "static", Address: "192.168.40.20/24", Gateway: "192.168.50.1", DNS: []string{"1.1.1.1"}}},
	} {
		if err := validateLocalNetworkProfile(profile); err == nil {
			t.Fatalf("invalid profile accepted: %+v", profile)
		}
	}
}

func TestLocalDevelopmentPolicyIsProtectedAndDisablingSSHRetainsLocalHash(t *testing.T) {
	path := filepath.Join(t.TempDir(), "development-access.json")
	policy, err := buildDevelopmentAccessPolicy(true, "a long local test passphrase", "a long local test passphrase", developmentAccessPolicy{})
	if err != nil {
		t.Fatal(err)
	}
	runner := &recordingLocalRunner{}
	if err := applyLocalDevelopmentPolicy(path, policy, runner); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 || runner.called != 1 {
		t.Fatalf("development access policy was not safely applied: info=%v calls=%d err=%v", info, runner.called, err)
	}
	localOnly, err := buildDevelopmentAccessPolicy(false, "", "", policy)
	if err != nil {
		t.Fatal(err)
	}
	if err := applyLocalDevelopmentPolicy(path, localOnly, runner); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(raw), "password_hash") || strings.Contains(string(raw), "local-subnet") {
		t.Fatalf("local console credential was not retained safely: %s (%v)", raw, err)
	}
}

func TestLocalDevelopmentTUIAlwaysMasksPassword(t *testing.T) {
	model := newLocalDevelopmentModel(filepath.Join(t.TempDir(), "development-access.json"), &recordingLocalRunner{})
	model.policy.LocalRootConsole = true
	model.cursor = 2
	model.inputs[0].Focus()
	updated, _ := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("never-render-this-passphrase")})
	view := updated.(localDevelopmentModel).View()
	if strings.Contains(view, "never-render-this-passphrase") || !strings.Contains(view, "••") {
		t.Fatalf("password input was not masked: %q", view)
	}
}

func TestSafeConsoleTextRemovesControlCharactersAndBoundsOutput(t *testing.T) {
	got := safeConsoleText("  line\nwith\x1b[31mcontrol and a deliberately long suffix", 20)
	if strings.ContainsAny(got, "\n\x1b") || len(got) > 20 {
		t.Fatalf("unsafe console text %q", got)
	}
}

func TestApplianceConsoleMutationsUsePAMSuAndRootLoginIsNotKindGated(t *testing.T) {
	for _, operation := range []string{"network", "development-access"} {
		command, err := applianceConsoleAuthenticatedCommand(operation)
		if err != nil {
			t.Fatal(err)
		}
		if command.Path != "/bin/su" || command.SysProcAttr == nil || command.SysProcAttr.Credential == nil || command.SysProcAttr.Credential.Uid == 0 {
			t.Fatalf("%s did not enter su from an unprivileged caller: path=%s attr=%+v", operation, command.Path, command.SysProcAttr)
		}
		if command.Stderr != os.Stdout {
			t.Fatalf("%s stock password prompt is not attached to the active console", operation)
		}
		if len(command.Args) != 5 || command.Args[1] != "-" || command.Args[2] != "root" || command.Args[3] != "-c" ||
			!strings.HasPrefix(command.Args[4], "exec ") || !strings.HasSuffix(command.Args[4], " '"+operation+"'") {
			t.Fatalf("%s command is not fixed to authenticated root execution: %q", operation, command.Args)
		}
	}
	if _, err := applianceConsoleAuthenticatedCommand("shell"); err == nil {
		t.Fatal("arbitrary console command was accepted")
	}
}

func TestApplianceConsoleRootLoginUsesStockLoginWithSUFallback(t *testing.T) {
	login := filepath.Join(t.TempDir(), "login")
	if err := os.WriteFile(login, []byte("fixture"), 0o755); err != nil {
		t.Fatal(err)
	}
	command, err := applianceConsoleLoginCommand([]string{login})
	if err != nil {
		t.Fatal(err)
	}
	if command.Path != login || strings.Join(command.Args[1:], " ") != "root" || command.Stderr != os.Stdout {
		t.Fatalf("stock login is not attached to the active console: path=%q args=%q stderr=%v", command.Path, command.Args, command.Stderr)
	}

	command, err = applianceConsoleLoginCommand([]string{filepath.Join(t.TempDir(), "missing")})
	if err != nil {
		t.Fatal(err)
	}
	if command.Path != "/bin/su" || command.SysProcAttr == nil || command.SysProcAttr.Credential == nil || command.SysProcAttr.Credential.Uid == 0 || command.Stderr != os.Stdout {
		t.Fatalf("stock su fallback is not an authenticated console command: path=%q attr=%+v stderr=%v", command.Path, command.SysProcAttr, command.Stderr)
	}
	if strings.Join(command.Args[1:], " ") != "- root" {
		t.Fatalf("stock su fallback does not request a root login shell: %q", command.Args)
	}
}
