package installer

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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

func TestApplianceConsoleShowsConsoleAccessWithoutHashes(t *testing.T) {
	root := t.TempDir()
	t.Setenv("YOUEYE_CONSOLE_STATE_ROOT", root)
	t.Setenv("YOUEYE_CONSOLE_RUN_DIR", filepath.Join(root, "run"))
	record := filepath.Join(root, "bootstrap", "console-access.json")
	if err := os.MkdirAll(filepath.Dir(record), 0o700); err != nil {
		t.Fatal(err)
	}
	view := (applianceConsoleModel{snapshot: readApplianceConsoleSnapshot()}).View()
	if !strings.Contains(view, "Admins sign in on Ctrl+Alt+F2") || strings.Contains(view, "Password SSH on") ||
		strings.Contains(view, "Configure and test wired network") || !strings.Contains(view, "sudo youeye-installer network") {
		t.Fatalf("default console access was not shown: %s", view)
	}
	hash := "$y$j9T$abcdefghijklmnop$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"
	raw := `{"schema":"youeye.console-access.v1","root_password_hash":"` + hash + `","password_ssh":true,"accounts":[{"user_id":"u1","username":"anna","uid":2001,"password_hash":"` + hash + `","admin":true,"locked":false}]}`
	if err := os.WriteFile(record, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	snapshot := readApplianceConsoleSnapshot()
	view = (applianceConsoleModel{snapshot: snapshot}).View()
	if !snapshot.ConsoleRootPassword || !snapshot.ConsolePasswordSSH || !strings.Contains(view, "Password SSH on (local network)") ||
		!strings.Contains(view, "Configure and test wired network") || strings.Contains(view, "$y$") {
		t.Fatalf("console access record was not summarised safely: %+v\n%s", snapshot, view)
	}
}

func TestApplianceConsoleShowsOwnerResetCodeWhileValid(t *testing.T) {
	root := t.TempDir()
	run := filepath.Join(root, "run")
	t.Setenv("YOUEYE_CONSOLE_STATE_ROOT", root)
	t.Setenv("YOUEYE_CONSOLE_RUN_DIR", run)
	for _, dir := range []string{run, filepath.Join(root, "console")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(run, "owner-reset-code"), []byte("ABCDE-FGHJK\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := readApplianceConsoleSnapshot().OwnerResetCode; got != "" {
		t.Fatalf("a code without a pending reset was shown: %q", got)
	}
	pending := filepath.Join(root, "console", "owner-reset.json")
	now := time.Now()
	write := func(expires time.Time) {
		raw := `{"schema":"youeye.owner-reset.v1","code_sha256":"x","expires_at":"` + expires.UTC().Format(time.RFC3339) + `","attempts":0}`
		if err := os.WriteFile(pending, []byte(raw), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(now.Add(time.Hour))
	snapshot := readApplianceConsoleSnapshot()
	snapshot.Domain, snapshot.IPv4Address = "box.example.test", "192.168.31.19"
	view := (applianceConsoleModel{snapshot: snapshot}).View()
	if snapshot.OwnerResetCode != "ABCDE-FGHJK" || !strings.Contains(view, "Owner password reset code: ABCDE-FGHJK") ||
		!strings.Contains(view, "https://192.168.31.19/settings/reset-owner") || !strings.Contains(view, "valid 24 hours, once") {
		t.Fatalf("owner reset code was not shown: %+v\n%s", snapshot, view)
	}
	write(now.Add(-time.Minute))
	if got := readApplianceConsoleSnapshot().OwnerResetCode; got != "" {
		t.Fatalf("an expired code was shown: %q", got)
	}
	write(now.Add(time.Hour))
	if err := os.WriteFile(filepath.Join(run, "owner-reset-code"), []byte("\x1b[31mABCDE-FGHJK\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := readApplianceConsoleSnapshot().OwnerResetCode; got != "" {
		t.Fatalf("a malformed code was shown: %q", got)
	}
}

func TestApplianceConsoleOffersOnlyTheNetworkCommand(t *testing.T) {
	model := applianceConsoleModel{}
	for _, key := range []rune{'d', 'l'} {
		if _, command := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{key}}); command != nil {
			t.Fatalf("key %q still starts a console command", key)
		}
	}
}

func TestApplianceConsoleCommandCompletionDoesNotMultiplyTicks(t *testing.T) {
	t.Setenv("YOUEYE_CONSOLE_STATE_ROOT", t.TempDir())
	model := applianceConsoleModel{}
	for i := 0; i < 3; i++ {
		updated, command := model.Update(consoleCommandFinished{})
		model = updated.(applianceConsoleModel)
		if command != nil {
			t.Fatal("command completion started a second polling loop")
		}
	}
	_, command := model.Update(consoleTick{})
	if command == nil {
		t.Fatal("regular snapshot tick must continue")
	}
}

// Before any admin can sign in, network setup needs no password (whoever is at
// an unclaimed box could claim it anyway); once an admin exists, it is
// sudo on tty2 (or the root password, when one is set).
func TestApplianceConsoleNetworkSetupBeforeAndAfterClaim(t *testing.T) {
	root := t.TempDir()
	t.Setenv("YOUEYE_CONSOLE_STATE_ROOT", root)
	t.Setenv("YOUEYE_CONSOLE_RUN_DIR", filepath.Join(root, "run"))
	record := filepath.Join(root, "bootstrap", "console-access.json")
	if err := os.MkdirAll(filepath.Dir(record), 0o700); err != nil {
		t.Fatal(err)
	}
	write := func(raw string) applianceConsoleModel {
		if err := os.WriteFile(record, []byte(raw), 0o600); err != nil {
			t.Fatal(err)
		}
		return applianceConsoleModel{snapshot: readApplianceConsoleSnapshot()}
	}
	press := func(model applianceConsoleModel) tea.Cmd {
		_, command := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'n'}})
		return command
	}
	unclaimed := write(`{"schema":"youeye.console-access.v1","password_ssh":false,"accounts":[{"user_id":"u1","username":"anna","uid":2001,"admin":true,"locked":true}]}`)
	if !unclaimed.snapshot.ConsoleUnclaimed || !strings.Contains(unclaimed.View(), "until the box has an admin") || press(unclaimed) == nil {
		t.Fatalf("unclaimed box must offer network setup: %+v", unclaimed.snapshot)
	}
	claimed := write(`{"schema":"youeye.console-access.v1","password_ssh":false,"claimed":true,"accounts":[{"user_id":"u1","username":"anna","uid":2001,"admin":true,"locked":false}]}`)
	if claimed.snapshot.ConsoleUnclaimed || !strings.Contains(claimed.View(), "sudo youeye-installer network") || press(claimed) != nil {
		t.Fatalf("a claimed box without a root password must use sudo on tty2: %+v", claimed.snapshot)
	}
	// Claimed stays claimed even when no admin account can sign in.
	lost := write(`{"schema":"youeye.console-access.v1","password_ssh":false,"claimed":true,"root_password_hash":"$argon2id$future","accounts":[{"user_id":"u1","username":"anna","uid":2001,"admin":true,"locked":true}]}`)
	if lost.snapshot.ConsoleUnclaimed || lost.snapshot.ConsoleRootPassword || press(lost) != nil {
		t.Fatalf("a claimed box must never open network setup without a password: %+v", lost.snapshot)
	}
	if err := os.Remove(record); err != nil {
		t.Fatal(err)
	}
	unknown := applianceConsoleModel{snapshot: readApplianceConsoleSnapshot()}
	if unknown.snapshot.ConsoleUnclaimed || press(unknown) != nil {
		t.Fatal("a missing record must not open network setup")
	}
}
