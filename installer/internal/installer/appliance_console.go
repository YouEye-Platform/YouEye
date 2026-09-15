package installer

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
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
	ImageVersion              string
	Slot                      string
	Stage                     string
	Detail                    string
	NetworkPhase              string
	NetworkDetail             string
	IPv4Address               string
	Domain                    string
	DevelopmentLocalRequested bool
	DevelopmentLocalEffective bool
	DevelopmentSSH            bool
	OverlayArtifact           string
	OverlayCommit             string
	Complete                  bool
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
		return model, applianceConsoleTick()
	case tea.KeyMsg:
		switch value.String() {
		case "n":
			return model, applianceConsoleAuthenticatedProcess("network")
		case "d":
			return model, applianceConsoleAuthenticatedProcess("development-access")
		case "l":
			model.snapshot = readApplianceConsoleSnapshot()
			if model.snapshot.DevelopmentLocalRequested && model.snapshot.DevelopmentLocalEffective {
				return model, applianceConsoleLogin()
			}
		case "ctrl+c":
			// This console is a supervised appliance surface. Ignore accidental
			// termination and keep the local recovery path available.
			return model, nil
		}
	}
	return model, nil
}

func applianceConsoleAuthenticatedProcess(command string) tea.Cmd {
	cmd, err := applianceConsoleAuthenticatedCommand(command)
	if err != nil {
		return func() tea.Msg { return consoleCommandFinished{err: err} }
	}
	return tea.ExecProcess(cmd, func(err error) tea.Msg { return consoleCommandFinished{err: err} })
}

func applianceConsoleAuthenticatedCommand(command string) (*exec.Cmd, error) {
	allowed := map[string]bool{"network": true, "development-access": true}
	if !allowed[command] {
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

func applianceConsoleLogin() tea.Cmd {
	cmd, err := applianceConsoleLoginCommand([]string{"/bin/login", "/usr/bin/login"})
	if err != nil {
		return func() tea.Msg { return consoleCommandFinished{err: err} }
	}
	return tea.ExecProcess(cmd, func(err error) tea.Msg {
		return consoleCommandFinished{err: err}
	})
}

func applianceConsoleLoginCommand(loginPaths []string) (*exec.Cmd, error) {
	for _, path := range loginPaths {
		info, err := os.Stat(path)
		if err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0 {
			cmd := exec.Command(path, "root")
			// Bubble Tea otherwise attaches child stderr to the service journal.
			// Debian login and su render their password prompt on stderr, so join
			// it to the active console's stdout before handing off the terminal.
			cmd.Stderr = os.Stdout
			return cmd, nil
		}
	}
	account, err := user.Lookup("nobody")
	if err != nil {
		return nil, fmt.Errorf("prepare stock root login: %w", err)
	}
	uid, uidErr := strconv.ParseUint(account.Uid, 10, 32)
	gid, gidErr := strconv.ParseUint(account.Gid, 10, 32)
	if uidErr != nil || gidErr != nil {
		return nil, fmt.Errorf("prepare stock root login identity")
	}
	return applianceConsoleSUCommand("", uint32(uid), uint32(gid)), nil
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
	development := "Local root login unavailable"
	if snapshot.DevelopmentLocalRequested && snapshot.DevelopmentLocalEffective {
		development = "Local root login on TTY2"
	}
	if snapshot.DevelopmentSSH {
		development += " + local-network password SSH"
	}
	rows = append(rows, fmt.Sprintf("Developer    %s", development), "")
	rows = append(rows,
		theme.Selected.Render("N")+"  Configure and test wired network (root password required)",
		theme.Selected.Render("D")+"  Development access (root password required)",
	)
	if snapshot.DevelopmentLocalRequested && snapshot.DevelopmentLocalEffective {
		rows = append(rows, theme.Selected.Render("L")+"  Open authenticated root login on this console")
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
	readConsoleJSON(filepath.Join(root, "bootstrap/development-access-status.json"), func(raw []byte) {
		var status struct {
			Schema                    string  `json:"schema"`
			LocalRootConsoleRequested *bool   `json:"local_root_console_requested"`
			LocalRootConsolePersisted *bool   `json:"local_root_console_persisted"`
			LocalRootConsoleActive    *bool   `json:"local_root_console_active"`
			LocalRootConsoleEffective *bool   `json:"local_root_console_effective"`
			RootPasswordSSHRequested  *bool   `json:"root_password_ssh_requested"`
			RootPasswordSSHEffective  *bool   `json:"root_password_ssh_effective"`
			NetworkScope              *string `json:"network_scope"`
			Detail                    *string `json:"detail"`
		}
		if strictConsoleJSON(raw, &status) != nil || !hasConsoleJSONFields(raw,
			"schema", "local_root_console_requested", "local_root_console_persisted",
			"local_root_console_active", "local_root_console_effective",
			"root_password_ssh_requested", "root_password_ssh_effective",
			"network_scope", "detail",
		) || status.Schema != "youeye.development-access-status.v2" ||
			status.LocalRootConsoleRequested == nil || status.LocalRootConsolePersisted == nil ||
			status.LocalRootConsoleActive == nil || status.LocalRootConsoleEffective == nil ||
			status.RootPasswordSSHRequested == nil || status.RootPasswordSSHEffective == nil ||
			(*status.LocalRootConsoleEffective && (!*status.LocalRootConsoleRequested || !*status.LocalRootConsolePersisted || !*status.LocalRootConsoleActive)) ||
			(*status.RootPasswordSSHEffective && (!*status.RootPasswordSSHRequested || status.NetworkScope == nil || strings.TrimSpace(*status.NetworkScope) == "")) ||
			(!*status.RootPasswordSSHEffective && status.NetworkScope != nil) {
			return
		}
		snapshot.DevelopmentLocalRequested = *status.LocalRootConsoleRequested
		snapshot.DevelopmentLocalEffective = *status.LocalRootConsoleEffective
		snapshot.DevelopmentSSH = *status.RootPasswordSSHEffective
	})
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

func strictConsoleJSON(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON value")
	}
	return nil
}

func hasConsoleJSONFields(raw []byte, names ...string) bool {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return false
	}
	for _, name := range names {
		if _, ok := fields[name]; !ok {
			return false
		}
	}
	return true
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
	program := tea.NewProgram(newApplianceConsoleModel(opts.ConsoleKind), tea.WithAltScreen())
	_, err := program.Run()
	return err
}
