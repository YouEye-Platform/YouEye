package installer

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestApplianceConsoleLabelsVerifiedUnsignedOverlay(t *testing.T) {
	root := t.TempDir()
	overlay := filepath.Join(root, "installer.json")
	if err := os.WriteFile(overlay, []byte(`{"schema":"youeye.development-overlay-runtime.v1","component":"installer","state":"active","unsigned":true,"artifact_id":"devart-b-1787209999-001","source_commit":"0123456789abcdef0123456789abcdef01234567"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("YOUEYE_CONSOLE_STATE_ROOT", root)
	t.Setenv("YOUEYE_CONSOLE_DEVELOPMENT_OVERLAY", overlay)
	snapshot := readApplianceConsoleSnapshot()
	if snapshot.OverlayArtifact != "devart-b-1787209999-001" || snapshot.OverlayCommit != "0123456789abcdef0123456789abcdef01234567" {
		t.Fatalf("overlay snapshot = %+v", snapshot)
	}
	view := (applianceConsoleModel{snapshot: snapshot}).View()
	if !strings.Contains(view, "Development unsigned Installer 0123456789ab · devart-b-1787209999-001") {
		t.Fatalf("unsigned overlay label missing: %s", view)
	}
}

func TestApplianceConsoleIgnoresUnverifiedOverlayStatus(t *testing.T) {
	root := t.TempDir()
	overlay := filepath.Join(root, "installer.json")
	if err := os.WriteFile(overlay, []byte(`{"schema":"youeye.development-overlay-runtime.v1","component":"installer","state":"active","unsigned":false,"artifact_id":"fake","source_commit":"fake"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("YOUEYE_CONSOLE_STATE_ROOT", root)
	t.Setenv("YOUEYE_CONSOLE_DEVELOPMENT_OVERLAY", overlay)
	snapshot := readApplianceConsoleSnapshot()
	if snapshot.OverlayArtifact != "" || snapshot.OverlayCommit != "" {
		t.Fatalf("unverified overlay was displayed: %+v", snapshot)
	}
}

func TestApplianceConsoleAdvertisesLocalLoginOnlyWhenTTY2V2IsEffective(t *testing.T) {
	root := t.TempDir()
	t.Setenv("YOUEYE_CONSOLE_STATE_ROOT", root)
	statusPath := filepath.Join(root, "bootstrap", "development-access-status.json")
	if err := os.MkdirAll(filepath.Dir(statusPath), 0o700); err != nil {
		t.Fatal(err)
	}
	valid := `{"schema":"youeye.development-access-status.v2","local_root_console_requested":true,"local_root_console_persisted":true,"local_root_console_active":true,"local_root_console_effective":true,"root_password_ssh_requested":false,"root_password_ssh_effective":false,"network_scope":null,"detail":"active"}`
	if err := os.WriteFile(statusPath, []byte(valid), 0o600); err != nil {
		t.Fatal(err)
	}
	snapshot := readApplianceConsoleSnapshot()
	view := (applianceConsoleModel{snapshot: snapshot}).View()
	if !snapshot.DevelopmentLocalRequested || !snapshot.DevelopmentLocalEffective || !strings.Contains(view, "Local root login on TTY2") || !strings.Contains(view, "Open authenticated root login on this console") {
		t.Fatalf("v2 effective local login was not advertised: %+v\n%s", snapshot, view)
	}

	for _, invalid := range []string{
		`{"schema":"youeye.development-access-status.v1","local_root_console":true,"root_password_ssh_requested":false,"root_password_ssh_effective":false,"network_scope":null,"detail":"legacy"}`,
		`{"schema":"youeye.development-access-status.v2","local_root_console_requested":true,"local_root_console_persisted":false,"local_root_console_active":true,"local_root_console_effective":true,"root_password_ssh_requested":false,"root_password_ssh_effective":false,"network_scope":null,"detail":"inconsistent"}`,
		`{"schema":"youeye.development-access-status.v2","local_root_console_requested":true,"local_root_console_persisted":true,"local_root_console_active":true,"local_root_console_effective":true,"root_password_ssh_requested":false,"root_password_ssh_effective":false,"network_scope":null}`,
		`{"schema":"youeye.development-access-status.v2","local_root_console_requested":true,"local_root_console_persisted":true,"local_root_console_active":true,"local_root_console_effective":true,"root_password_ssh_requested":false,"root_password_ssh_effective":false,"network_scope":null,"detail":"unknown","extra":true}`,
		`{"schema":"youeye.development-access-status.v2","local_root_console_requested":true,"local_root_console_persisted":true,"local_root_console_active":true,"local_root_console_effective":true,"root_password_ssh_requested":false,"root_password_ssh_effective":false,"network_scope":null}`,
	} {
		if err := os.WriteFile(statusPath, []byte(invalid), 0o600); err != nil {
			t.Fatal(err)
		}
		snapshot = readApplianceConsoleSnapshot()
		view = (applianceConsoleModel{snapshot: snapshot}).View()
		if snapshot.DevelopmentLocalRequested || snapshot.DevelopmentLocalEffective || strings.Contains(view, "Open authenticated root login on this console") {
			t.Fatalf("invalid applied record exposed local login: %+v\n%s", snapshot, view)
		}
	}
}

func TestApplianceConsoleRechecksEffectiveStateBeforeLogin(t *testing.T) {
	root := t.TempDir()
	t.Setenv("YOUEYE_CONSOLE_STATE_ROOT", root)
	statusPath := filepath.Join(root, "bootstrap", "development-access-status.json")
	if err := os.MkdirAll(filepath.Dir(statusPath), 0o700); err != nil {
		t.Fatal(err)
	}
	disabled := `{"schema":"youeye.development-access-status.v2","local_root_console_requested":false,"local_root_console_persisted":false,"local_root_console_active":false,"local_root_console_effective":false,"root_password_ssh_requested":false,"root_password_ssh_effective":false,"network_scope":null,"detail":"disabled"}`
	if err := os.WriteFile(statusPath, []byte(disabled), 0o600); err != nil {
		t.Fatal(err)
	}
	model := applianceConsoleModel{snapshot: applianceConsoleSnapshot{
		DevelopmentLocalRequested: true,
		DevelopmentLocalEffective: true,
	}}
	updated, command := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'l'}})
	got := updated.(applianceConsoleModel)
	if command != nil || got.snapshot.DevelopmentLocalRequested || got.snapshot.DevelopmentLocalEffective {
		t.Fatalf("stale effective state exposed login: command=%v snapshot=%+v", command, got.snapshot)
	}
}
