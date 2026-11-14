package installer

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/youeye-platform/YouEye/installer/internal/installer/theme"
)

type consoleTick time.Time
type consoleCommandFinished struct{ err error }

type applianceConsoleSnapshot struct {
	ImageVersion        string
	Slot                string
	Stage               string
	Detail              string
	NetworkPhase        string
	NetworkDetail       string
	IPv4Address         string
	Domain              string
	ConsoleRootPassword bool
	ConsolePasswordSSH  bool
	// ConsoleUnclaimed: the record was read and holds no admin who can sign
	// in, so there is nobody to protect network setup from yet.
	ConsoleUnclaimed bool
	OwnerResetCode   string
	OverlayArtifact  string
	OverlayCommit    string
	Complete         bool
}

type applianceConsoleModel struct {
	kind     string
	snapshot applianceConsoleSnapshot
	err      string
}

func newApplianceConsoleModel(kind string) applianceConsoleModel {
	return applianceConsoleModel{kind: kind, snapshot: readApplianceConsoleSnapshot()}
}

func (model applianceConsoleModel) Init() tea.Cmd { return applianceConsoleTick() }

func applianceConsoleTick() tea.Cmd {
	return tea.Tick(2*time.Second, func(value time.Time) tea.Msg { return consoleTick(value) })
}

func (model applianceConsoleModel) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch value := message.(type) {
	case consoleTick:
		model.snapshot = readApplianceConsoleSnapshot()
		return model, applianceConsoleTick()
	case consoleCommandFinished:
		if value.err != nil {
			model.err = safeConsoleText(value.err.Error(), 160)
		} else {
			model.err = ""
		}
		model.snapshot = readApplianceConsoleSnapshot()
		// The existing snapshot tick survives ExecProcess; scheduling another
		// here would multiply the polling loops after each console command.
		return model, nil
	case tea.KeyMsg:
		switch value.String() {
		case "n":
			switch {
			case model.snapshot.ConsoleUnclaimed && !model.snapshot.ConsoleRootPassword:
				// Before an admin exists, whoever is at the box could claim it
				// anyway; a broken network must not force a reinstall.
				return model, applianceConsoleDirectProcess("network")
			case model.snapshot.ConsoleRootPassword:
				return model, applianceConsoleAuthenticatedProcess("network")
			}
			return model, nil
		case "ctrl+c":
			// This console is a supervised appliance surface. Ignore accidental
			// termination and keep the local recovery path available.
			return model, nil
		}
	}
	return model, nil
}

func applianceConsoleDirectProcess(command string) tea.Cmd {
	executable, err := os.Executable()
	if err != nil {
		executable = "/usr/local/bin/youeye-installer"
	}
	return tea.ExecProcess(exec.Command(executable, command), func(err error) tea.Msg { return consoleCommandFinished{err: err} })
}

func applianceConsoleAuthenticatedProcess(command string) tea.Cmd {
	cmd, err := applianceConsoleAuthenticatedCommand(command)
	if err != nil {
		return func() tea.Msg { return consoleCommandFinished{err: err} }
	}
	return tea.ExecProcess(cmd, func(err error) tea.Msg { return consoleCommandFinished{err: err} })
}

func applianceConsoleAuthenticatedCommand(command string) (*exec.Cmd, error) {
	if command != "network" {
		return nil, fmt.Errorf("unsupported authenticated console command")
	}
	executable, err := os.Executable()
	if err != nil {
		executable = "/usr/local/bin/youeye-installer"
	}
	account, err := user.Lookup("nobody")
	if err != nil {
		return nil, fmt.Errorf("prepare authenticated console: %w", err)
	}
	uid, uidErr := strconv.ParseUint(account.Uid, 10, 32)
	gid, gidErr := strconv.ParseUint(account.Gid, 10, 32)
	if uidErr != nil || gidErr != nil {
		return nil, fmt.Errorf("prepare authenticated console identity")
	}
	return applianceConsoleSUCommand("exec "+shellQuote(executable)+" "+shellQuote(command), uint32(uid), uint32(gid)), nil
}

func applianceConsoleSUCommand(rootCommand string, uid, gid uint32) *exec.Cmd {
	args := []string{"-", "root"}
	if rootCommand != "" {
		args = append(args, "-c", rootCommand)
	}
	cmd := exec.Command("/bin/su", args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uid, Gid: gid, Groups: []uint32{gid}}}
	cmd.Stderr = os.Stdout
	return cmd
}

func (model applianceConsoleModel) View() string {
	snapshot := model.snapshot
	status, statusStyle := "Starting appliance services", theme.Title
	if snapshot.Stage == "needs_attention" || snapshot.NetworkPhase == "needs_attention" {
		status, statusStyle = "Needs attention", theme.Danger
	} else if snapshot.Complete {
		status, statusStyle = "Ready", theme.Selected
	} else if snapshot.Detail != "" {
		status = snapshot.Detail
	}
	address := snapshot.IPv4Address
	if address == "" {
		address = "waiting for wired IPv4"
	}
	rows := []string{
		theme.Title.Render(" __   __          _____"),
		theme.Title.Render(" \\ \\ / /__  _   _| ____|_   _  ___"),
		theme.Title.Render("  \\ V / _ \\| | | |  _| | | | |/ _ \\"),
		theme.Title.Render("   | | (_) | |_| | |___| |_| |  __/"),
		theme.Title.Render("   |_|\\___/ \\__, |_____|\\__, |\\___|"),
		theme.Title.Render("             |___/       |___/"), "",
		statusStyle.Render(status), "",
		fmt.Sprintf("Setup       https://%s", address),
		fmt.Sprintf("System      slot %s · image %s", valueOr(snapshot.Slot, "?"), valueOr(snapshot.ImageVersion, "unknown")),
		fmt.Sprintf("Network     %s", valueOr(snapshot.NetworkPhase, "starting")),
	}
	if snapshot.OverlayArtifact != "" {
		commit := snapshot.OverlayCommit
		if len(commit) > 12 {
			commit = commit[:12]
		}
		rows = append(rows, fmt.Sprintf("Development unsigned Installer %s · %s", commit, snapshot.OverlayArtifact))
	}
	if snapshot.Domain != "" {
		rows = append(rows, fmt.Sprintf("Server      https://%s/", snapshot.Domain))
	}
	if snapshot.NetworkDetail != "" {
		rows = append(rows, "             "+snapshot.NetworkDetail)
	}
	rows = append(rows, "Console     Admins sign in on Ctrl+Alt+F2")
	if snapshot.ConsolePasswordSSH {
		rows = append(rows, "            Password SSH on (local network)")
	}
	rows = append(rows, "")
	if snapshot.OwnerResetCode != "" {
		// The reset page answers only on the box's own address (not its name).
		box := snapshot.IPv4Address
		rows = append(rows,
			theme.Selected.Render("Owner password reset code: "+snapshot.OwnerResetCode),
			fmt.Sprintf("Open https://%s/settings/reset-owner and enter it.", valueOr(box, "<this box's IP address>")),
			"The code is valid 24 hours, once.", "")
	}
	if snapshot.ConsoleUnclaimed && !snapshot.ConsoleRootPassword {
		rows = append(rows, theme.Selected.Render("N")+"  Configure and test wired network (until the box has an admin)")
	} else if snapshot.ConsoleRootPassword {
		rows = append(rows, theme.Selected.Render("N")+"  Configure and test wired network (root password required)")
	} else {
		rows = append(rows, "Net setup   on Ctrl+Alt+F2: sudo youeye-installer network")
	}
	rows = append(rows, "", "Recovery: choose YouEye Recovery from the UEFI boot menu")
	if model.err != "" {
		rows = append(rows, "", theme.Danger.Render(model.err))
	}
	return localPanelContent(rows)
}

func readApplianceConsoleSnapshot() applianceConsoleSnapshot {
	root := envOrDefault("YOUEYE_CONSOLE_STATE_ROOT", "/var/lib/youeye-state")
	snapshot := applianceConsoleSnapshot{}
	readConsoleJSON("/usr/lib/youeye/appliance-release", func(raw []byte) {
		var release struct {
			ImageVersion string `json:"image_version"`
		}
		if json.Unmarshal(raw, &release) == nil {
			snapshot.ImageVersion = safeConsoleText(release.ImageVersion, 64)
		}
	})
	readConsoleJSON(filepath.Join(root, "appliance-state.json"), func(raw []byte) {
		var state struct {
			Slots struct {
				Current string `json:"current"`
			} `json:"slots"`
		}
		if json.Unmarshal(raw, &state) == nil {
			snapshot.Slot = safeConsoleText(state.Slots.Current, 2)
		}
	})
	readConsoleJSON(filepath.Join(root, "first-deploy/progress.json"), func(raw []byte) {
		var progress struct {
			Stage  string `json:"stage"`
			Detail string `json:"detail"`
		}
		if json.Unmarshal(raw, &progress) == nil {
			snapshot.Stage = safeConsoleText(progress.Stage, 48)
			snapshot.Detail = safeConsoleText(progress.Detail, 100)
		}
	})
	readConsoleJSON(filepath.Join(root, "bootstrap/network-status.json"), func(raw []byte) {
		var status struct {
			Phase  string `json:"phase"`
			Detail string `json:"detail"`
		}
		if json.Unmarshal(raw, &status) == nil {
			snapshot.NetworkPhase = safeConsoleText(status.Phase, 48)
			snapshot.NetworkDetail = safeConsoleText(status.Detail, 100)
		}
	})
	// Console access: only whether root has a password and password SSH is
	// on. The record holds password hashes; they are never shown.
	readConsoleJSON(filepath.Join(root, "bootstrap/console-access.json"), func(raw []byte) {
		var record struct {
			Schema           string `json:"schema"`
			RootPasswordHash string `json:"root_password_hash"`
			PasswordSSH      bool   `json:"password_ssh"`
			Claimed          bool   `json:"claimed"`
			Accounts         []struct {
				Admin  bool `json:"admin"`
				Locked bool `json:"locked"`
			} `json:"accounts"`
		}
		if json.Unmarshal(raw, &record) == nil && record.Schema == "youeye.console-access.v1" {
			// Spine treats a hash it can't use as no root password (root locked).
			snapshot.ConsoleRootPassword = validYescryptHash(record.RootPasswordHash)
			snapshot.ConsolePasswordSSH = record.PasswordSSH
			// Claimed is sticky (set by the first admin sync, cleared only by a
			// factory reset), so a lost or locked admin account never reopens it.
			snapshot.ConsoleUnclaimed = !record.Claimed
			for _, account := range record.Accounts {
				if account.Admin && !account.Locked {
					snapshot.ConsoleUnclaimed = false
				}
			}
		}
	})
	snapshot.OwnerResetCode = readOwnerResetCode(root, envOrDefault("YOUEYE_CONSOLE_RUN_DIR", "/run/youeye/console"), time.Now())
	readConsoleJSON(envOrDefault("YOUEYE_CONSOLE_DEVELOPMENT_OVERLAY", "/run/youeye/development-overlay/installer.json"), func(raw []byte) {
		var overlay struct {
			Schema       string `json:"schema"`
			Component    string `json:"component"`
			State        string `json:"state"`
			Unsigned     bool   `json:"unsigned"`
			ArtifactID   string `json:"artifact_id"`
			SourceCommit string `json:"source_commit"`
		}
		if json.Unmarshal(raw, &overlay) == nil && overlay.Schema == "youeye.development-overlay-runtime.v1" && overlay.Component == "installer" && overlay.State == "active" && overlay.Unsigned {
			snapshot.OverlayArtifact = safeConsoleText(overlay.ArtifactID, 80)
			snapshot.OverlayCommit = safeConsoleText(overlay.SourceCommit, 40)
		}
	})
	if raw, err := os.ReadFile("/var/lib/youeye/config/youeye.yaml"); err == nil && len(raw) <= 1<<20 {
		for _, line := range strings.Split(string(raw), "\n") {
			if key, value, ok := strings.Cut(line, ":"); ok && strings.TrimSpace(key) == "domain" {
				value = strings.Trim(strings.TrimSpace(value), "\"'")
				if value != "" && len(value) <= 253 && !strings.ContainsAny(value, "/\\:@ \t\r\n") {
					snapshot.Domain = safeConsoleText(value, 253)
				}
				break
			}
		}
	}
	if info, err := os.Stat(filepath.Join(root, "first-deploy/complete")); err == nil && info.Mode().IsRegular() {
		snapshot.Complete = true
	}
	if interfaces, err := netInterfaces(); err == nil {
		snapshot.IPv4Address = interfaces
	}
	return snapshot
}

var ownerResetCodePattern = regexp.MustCompile(`^[A-Z0-9]{5}-[A-Z0-9]{5}$`)

// readOwnerResetCode returns the one-time owner reset code Spine issued after
// Recovery's "Reset owner password", while its State record is unexpired.
func readOwnerResetCode(stateRoot, runDir string, now time.Time) string {
	raw, err := os.ReadFile(filepath.Join(runDir, "owner-reset-code"))
	if err != nil || len(raw) > 64 {
		return ""
	}
	code := strings.TrimSpace(string(raw))
	if !ownerResetCodePattern.MatchString(code) {
		return ""
	}
	pending, err := os.ReadFile(filepath.Join(stateRoot, "console/owner-reset.json"))
	if err != nil || len(pending) > 1<<16 {
		return ""
	}
	var record struct {
		Schema    string `json:"schema"`
		ExpiresAt string `json:"expires_at"`
	}
	if json.Unmarshal(pending, &record) != nil || record.Schema != "youeye.owner-reset.v1" {
		return ""
	}
	expires, err := time.Parse(time.RFC3339, record.ExpiresAt)
	if err != nil || !now.Before(expires) {
		return ""
	}
	return code
}

func netInterfaces() (string, error) {
	interfaces, err := net.InterfaceAddrs()
	if err != nil {
		return "", err
	}
	for _, address := range interfaces {
		ip, _, parseErr := net.ParseCIDR(address.String())
		if parseErr == nil && ip.To4() != nil && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() {
			return ip.String(), nil
		}
	}
	return "", errors.New("no usable IPv4 address")
}

func readConsoleJSON(path string, apply func([]byte)) {
	raw, err := os.ReadFile(path)
	if err == nil && len(raw) <= 1<<20 {
		apply(raw)
	}
}

func safeConsoleText(value string, limit int) string {
	value = strings.Map(func(character rune) rune {
		if character < 0x20 || character == 0x7f {
			return -1
		}
		return character
	}, strings.TrimSpace(value))
	if len(value) > limit {
		return value[:limit]
	}
	return value
}

func valueOr(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

// RunApplianceConsole runs the always-available local bootstrap/status TUI.
func RunApplianceConsole(opts CLIOptions) error {
	program := tea.NewProgram(newApplianceConsoleModel(opts.ConsoleKind), tea.WithAltScreen(), tea.WithFPS(5))
	_, err := program.Run()
	return err
}
