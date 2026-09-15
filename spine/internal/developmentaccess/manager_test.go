package developmentaccess

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

type recordingRunner struct {
	calls int
	run   func() error
}

func (runner *recordingRunner) Run(name string, args ...string) error {
	runner.calls++
	if runner.run != nil {
		return runner.run()
	}
	return nil
}

func TestStatusNeverReturnsPasswordHashAndDisableRemovesIt(t *testing.T) {
	root := t.TempDir()
	hash := "$y$j9T$AAt9R641xPvCI9nXw1HHW/$cuQRBMN3N/f8IcmVN.4YrZ1bHMOiLOoz9/XQMKV/v0A"
	if err := os.WriteFile(filepath.Join(root, "development-access.json"), []byte(`{"schema":"youeye.development-access.v1","local_root_console":true,"root_password_ssh":true,"password_hash":"`+hash+`","ssh_network_scope":"local-subnet"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "development-access-status.json"), []byte(`{"schema":"youeye.development-access-status.v2","local_root_console_requested":true,"local_root_console_persisted":true,"local_root_console_active":true,"local_root_console_effective":true,"root_password_ssh_requested":true,"root_password_ssh_effective":true,"network_scope":"192.0.2.0/24","detail":"active"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	runner := &recordingRunner{run: func() error {
		return os.WriteFile(filepath.Join(root, "development-access-status.json"), []byte(`{"schema":"youeye.development-access-status.v2","local_root_console_requested":false,"local_root_console_persisted":false,"local_root_console_active":false,"local_root_console_effective":false,"root_password_ssh_requested":false,"root_password_ssh_effective":false,"network_scope":null,"detail":"Secure defaults active"}`), 0o600)
	}}
	manager := &Manager{Root: root, Runner: runner}
	status, err := manager.Status()
	if err != nil || !status.LocalRootConsoleEffective || !status.RootPasswordSSHEffective || status.CanEnableRemotely {
		t.Fatalf("unexpected status: %+v %v", status, err)
	}
	if _, err := manager.Disable(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(root, "development-access.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != "{\"schema\":\"youeye.development-access.v1\",\"local_root_console\":false,\"root_password_ssh\":false}\n" || runner.calls != 1 {
		t.Fatalf("disable did not remove secret state or apply once: %q calls=%d", raw, runner.calls)
	}
}

func TestStatusLegacyAndMissingAppliedRecordsFailClosed(t *testing.T) {
	root := t.TempDir()
	writePolicy(t, root, true, true)
	for _, status := range []string{
		`{"schema":"youeye.development-access-status.v1","local_root_console":true,"root_password_ssh_requested":true,"root_password_ssh_effective":true,"network_scope":"192.0.2.0/24","detail":"active"}`,
	} {
		if err := os.WriteFile(filepath.Join(root, "development-access-status.json"), []byte(status), 0o600); err != nil {
			t.Fatal(err)
		}
		status, err := (&Manager{Root: root}).Status()
		if err != nil {
			t.Fatal(err)
		}
		if !status.LocalRootConsoleRequested || !status.RootPasswordSSHRequested || status.LocalRootConsolePersisted || status.LocalRootConsoleActive || status.LocalRootConsoleEffective || status.RootPasswordSSHEffective || status.NetworkScope != nil || status.Detail != notAppliedDetail {
			t.Fatalf("legacy applied status was not fail-closed: %+v", status)
		}
	}
	if err := os.Remove(filepath.Join(root, "development-access-status.json")); err != nil {
		t.Fatal(err)
	}
	status, err := (&Manager{Root: root}).Status()
	if err != nil {
		t.Fatal(err)
	}
	if !status.LocalRootConsoleRequested || !status.RootPasswordSSHRequested || status.LocalRootConsoleEffective || status.RootPasswordSSHEffective || status.Detail != notAppliedDetail {
		t.Fatalf("missing applied status was not fail-closed: %+v", status)
	}
}

func TestStatusRejectsMalformedOrInconsistentV2AppliedRecords(t *testing.T) {
	root := t.TempDir()
	writePolicy(t, root, true, true)
	for _, record := range []string{
		`{"schema":"youeye.development-access-status.v2","local_root_console_requested":true,"local_root_console_persisted":true,"local_root_console_active":true,"local_root_console_effective":true,"root_password_ssh_requested":true,"root_password_ssh_effective":true,"detail":"missing scope"}`,
		`{"schema":"youeye.development-access-status.v2","local_root_console_requested":false,"local_root_console_persisted":true,"local_root_console_active":true,"local_root_console_effective":true,"root_password_ssh_requested":false,"root_password_ssh_effective":false,"network_scope":null,"detail":"invalid local state"}`,
		`{"schema":"youeye.development-access-status.v2","local_root_console_requested":null,"local_root_console_persisted":false,"local_root_console_active":false,"local_root_console_effective":false,"root_password_ssh_requested":true,"root_password_ssh_effective":false,"network_scope":null,"detail":"null requested"}`,
		`{"schema":"youeye.development-access-status.v2","local_root_console_requested":true,"local_root_console_persisted":false,"local_root_console_active":false,"local_root_console_effective":false,"root_password_ssh_requested":true,"root_password_ssh_effective":false,"network_scope":null,"detail":null}`,
		`{"schema":"youeye.development-access-status.v3","detail":"unknown schema"}`,
		`{"local_root_console":true,"root_password_ssh_requested":true,"root_password_ssh_effective":true,"network_scope":"192.0.2.0/24","detail":"missing schema"}`,
		`{"schema":"youeye.development-access-status.v2","local_root_console_requested":true,"local_root_console_persisted":true,"local_root_console_active":true,"local_root_console_effective":true,"root_password_ssh_requested":false,"root_password_ssh_effective":false,"network_scope":null,"detail":"extra","unexpected":true}`,
	} {
		if err := os.WriteFile(filepath.Join(root, "development-access-status.json"), []byte(record), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := (&Manager{Root: root}).Status(); err == nil {
			t.Fatalf("accepted invalid status record: %s", record)
		}
	}
}

func TestStatusBoundsAndSanitizesV2Detail(t *testing.T) {
	root := t.TempDir()
	writePolicy(t, root, false, false)
	detail := " active\n" + strings.Repeat("x", 200)
	record := `{"schema":"youeye.development-access-status.v2","local_root_console_requested":false,"local_root_console_persisted":false,"local_root_console_active":false,"local_root_console_effective":false,"root_password_ssh_requested":false,"root_password_ssh_effective":false,"network_scope":null,"detail":` + quoteJSON(t, detail) + `}`
	if err := os.WriteFile(filepath.Join(root, "development-access-status.json"), []byte(record), 0o600); err != nil {
		t.Fatal(err)
	}
	status, err := (&Manager{Root: root}).Status()
	if err != nil {
		t.Fatal(err)
	}
	if len(status.Detail) != 160 || strings.ContainsAny(status.Detail, "\r\n\t") {
		t.Fatalf("detail was not bounded and sanitized: %q", status.Detail)
	}
}

func writePolicy(t *testing.T, root string, local, ssh bool) {
	t.Helper()
	policy := `{"schema":"youeye.development-access.v1","local_root_console":false,"root_password_ssh":false}`
	if local || ssh {
		policy = `{"schema":"youeye.development-access.v1","local_root_console":` + strconv.FormatBool(local) + `,"root_password_ssh":` + strconv.FormatBool(ssh) + `,"password_hash":"$y$test","ssh_network_scope":"local-subnet"}`
	}
	if err := os.WriteFile(filepath.Join(root, "development-access.json"), []byte(policy), 0o600); err != nil {
		t.Fatal(err)
	}
}

func quoteJSON(t *testing.T, value string) string {
	t.Helper()
	return strconv.Quote(value)
}
