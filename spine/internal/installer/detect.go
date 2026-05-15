package installer

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/YouEye-Platform/YouEye/spine/internal/installer/theme"
)

// ---------------------------------------------------------------------------
// Real environment detection (runs in a tea.Cmd goroutine)
// ---------------------------------------------------------------------------

// detectResultMsg carries the detection result back to the TUI.
type detectResultMsg struct {
	env envInfo
	err error
}

// runRealDetection returns a Cmd that performs real environment scanning.
func runRealDetection() tea.Cmd {
	return func() tea.Msg {
		env, err := detectEnvironment()
		return detectResultMsg{env: env, err: err}
	}
}

// detectEnvironment runs real shell commands to discover the host.
func detectEnvironment() (envInfo, error) {
	var env envInfo

	// OS detection from /etc/os-release
	if data, err := os.ReadFile("/etc/os-release"); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(line, "PRETTY_NAME=") {
				env.OS = strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), "\"")
			}
		}
	}
	if env.OS == "" {
		env.OS = "Linux (unknown)"
	}

	// Architecture
	if out, err := exec.Command("dpkg", "--print-architecture").Output(); err == nil {
		env.Arch = strings.TrimSpace(string(out))
	} else {
		// Fallback
		if out, err := exec.Command("uname", "-m").Output(); err == nil {
			env.Arch = strings.TrimSpace(string(out))
		}
	}

	// Kernel
	if out, err := exec.Command("uname", "-r").Output(); err == nil {
		env.Kernel = strings.TrimSpace(string(out))
	}

	// Container detection — abort if we're inside one
	// systemd-detect-virt returns exit code 1 for "none", so check output regardless
	if out, err := exec.Command("systemd-detect-virt", "-c").CombinedOutput(); err == nil || len(out) > 0 {
		vtype := strings.TrimSpace(string(out))
		if vtype != "none" && vtype != "" {
			env.IsContainer = true
			env.ContainerType = vtype
		}
	}

	// VM detection — treat as bare Linux
	if out, err := exec.Command("systemd-detect-virt").CombinedOutput(); err == nil || len(out) > 0 {
		vtype := strings.TrimSpace(string(out))
		if vtype == "kvm" || vtype == "vmware" || vtype == "xen" || vtype == "microsoft" {
			env.IsVM = true
		}
	}

	// Proxmox detection
	if out, err := exec.Command("pveversion").Output(); err == nil {
		env.IsProxmox = true
		// Parse: "pve-manager/8.3.2/abc123..." → "8.3.2"
		parts := strings.Split(strings.TrimSpace(string(out)), "/")
		if len(parts) >= 2 {
			env.PVEVersion = parts[1]
		}
	}

	// Proxmox-specific queries
	if env.IsProxmox {
		env.RootdirPools = parseStoragePools("rootdir")
		env.VztmplPools = parseStoragePools("vztmpl")
		env.ImagePools = parseStoragePools("images")

		env.Bridges = detectBridges()

		// Next available ID
		if out, err := exec.Command("pvesh", "get", "/cluster/nextid").Output(); err == nil {
			env.NextID = strings.TrimSpace(string(out))
		} else {
			env.Warnings = append(env.Warnings, "Could not determine next ID (cluster API)")
			env.NextID = "100"
		}

		// Already-downloaded templates
		for _, pool := range env.VztmplPools {
			env.Templates = append(env.Templates, listTemplates(pool.Name)...)
		}

		// Warnings for missing pools
		if len(env.RootdirPools) == 0 {
			env.Warnings = append(env.Warnings, "No storage pools support container rootfs")
		}
		if len(env.VztmplPools) == 0 {
			env.Warnings = append(env.Warnings, "No storage pools support templates")
		}
		if len(env.Bridges) == 0 {
			env.Warnings = append(env.Warnings, "No network bridges detected")
		}
	}

	return env, nil
}

// parseStoragePools runs pvesm status and parses the table output.
func parseStoragePools(contentType string) []storagePool {
	out, err := exec.Command("pvesm", "status", "-content", contentType).Output()
	if err != nil {
		return nil
	}
	var pools []storagePool
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 7 {
			continue
		}
		// Skip header row
		if fields[0] == "Name" {
			continue
		}
		total, _ := strconv.ParseInt(fields[3], 10, 64)
		used, _ := strconv.ParseInt(fields[4], 10, 64)
		avail, _ := strconv.ParseInt(fields[5], 10, 64)
		pools = append(pools, storagePool{
			Name:     fields[0],
			Type:     fields[1],
			Status:   fields[2],
			TotalKiB: total,
			UsedKiB:  used,
			AvailKiB: avail,
		})
	}
	return pools
}

// detectBridges finds network bridges, filtering out Proxmox firewall bridges.
func detectBridges() []string {
	out, err := exec.Command("ip", "-j", "link", "show", "type", "bridge").Output()
	if err != nil {
		return nil
	}
	var links []struct {
		Ifname string `json:"ifname"`
	}
	if err := json.Unmarshal(out, &links); err != nil {
		return nil
	}
	var bridges []string
	for _, l := range links {
		// Filter out transient firewall bridges (fwbr*) and incus bridges
		if strings.HasPrefix(l.Ifname, "fwbr") || strings.HasPrefix(l.Ifname, "incusbr") {
			continue
		}
		bridges = append(bridges, l.Ifname)
	}
	return bridges
}

// listTemplates returns template refs for a storage pool.
func listTemplates(poolName string) []string {
	out, err := exec.Command("pveam", "list", poolName).Output()
	if err != nil {
		return nil
	}
	var templates []string
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 1 && strings.Contains(fields[0], ":") && strings.Contains(fields[0], "vztmpl") {
			templates = append(templates, fields[0])
		}
	}
	return templates
}

// ---------------------------------------------------------------------------
// Detect TUI model — animated reveal of real detection results
// ---------------------------------------------------------------------------

type detectModel struct {
	width, height int
	frame         int
	revealed      int  // how many result lines are visible
	scanning      bool // true while background detection runs
	done          bool
	env           envInfo
	err           error
}

type detectTickMsg time.Time

func detectTick() tea.Cmd {
	return tea.Tick(200*time.Millisecond, func(t time.Time) tea.Msg { return detectTickMsg(t) })
}

type detectLine struct {
	label  string
	value  string
	status string // "ok", "warn", "fail"
}

func (d detectModel) lines() []detectLine {
	e := d.env
	var lines []detectLine

	// OS
	osStatus := "ok"
	if e.OS == "" || e.OS == "Linux (unknown)" {
		osStatus = "warn"
	}
	lines = append(lines, detectLine{"Operating System", e.OS, osStatus})

	// Architecture
	archStatus := "ok"
	if e.Arch != "amd64" {
		archStatus = "fail"
	}
	lines = append(lines, detectLine{"Architecture", e.Arch, archStatus})

	// Environment type
	if e.IsContainer {
		lines = append(lines, detectLine{"Environment", fmt.Sprintf("Container (%s) — cannot install here", e.ContainerType), "fail"})
	} else if e.IsProxmox {
		lines = append(lines, detectLine{"Proxmox VE", e.PVEVersion, "ok"})
	} else if e.IsVM {
		lines = append(lines, detectLine{"Environment", "Virtual Machine — direct install", "ok"})
	} else {
		lines = append(lines, detectLine{"Proxmox VE", "not detected — bare Linux mode", "warn"})
	}

	// Kernel
	lines = append(lines, detectLine{"Kernel", e.Kernel, "ok"})

	// Proxmox details
	if e.IsProxmox {
		poolCount := len(e.AllPools())
		poolStatus := "ok"
		if poolCount == 0 {
			poolStatus = "fail"
		}
		lines = append(lines, detectLine{"Storage pools", fmt.Sprintf("%d pool(s) available", poolCount), poolStatus})

		bridgeStatus := "ok"
		if len(e.Bridges) == 0 {
			bridgeStatus = "fail"
		}
		lines = append(lines, detectLine{"Network bridges", fmt.Sprintf("%d bridge(s) found", len(e.Bridges)), bridgeStatus})

		tmplStatus := "ok"
		tmplText := fmt.Sprintf("%d template(s) cached", len(e.Templates))
		if len(e.Templates) == 0 {
			tmplStatus = "warn"
			tmplText = "none cached (will download)"
		}
		lines = append(lines, detectLine{"Templates", tmplText, tmplStatus})
	}

	return lines
}

func newDetectModel() detectModel {
	return detectModel{scanning: true}
}

func (d detectModel) Init() tea.Cmd {
	return tea.Batch(detectTick(), runRealDetection())
}

func (d detectModel) Update(msg tea.Msg) (detectModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		d.width, d.height = msg.Width, msg.Height

	case detectResultMsg:
		d.env = msg.env
		d.err = msg.err
		d.scanning = false
		d.frame = 0
		d.revealed = 0
		return d, detectTick()

	case detectTickMsg:
		_ = msg
		d.frame++
		if d.scanning {
			// Still running detection — keep spinner going
			return d, detectTick()
		}
		// Revealing results
		total := len(d.lines())
		if d.revealed < total {
			d.revealed++
			return d, detectTick()
		}
		// Pause after all revealed, then mark done
		if d.frame > d.revealed+3 {
			d.done = true
		}
		return d, detectTick()

	case tea.KeyMsg:
		if d.scanning {
			return d, nil // can't skip while scanning
		}
		d.revealed = len(d.lines())
		d.done = true
	}
	return d, nil
}

func (d detectModel) View() string {
	if d.scanning {
		return d.viewScanning()
	}
	if d.err != nil {
		return d.viewError()
	}
	return d.viewReveal()
}

func (d detectModel) viewScanning() string {
	spinner := []string{"◐", "◓", "◑", "◒"}[d.frame%4]
	title := theme.Title.Render("  Detecting environment...")

	body := title + "\n\n"
	body += fmt.Sprintf("  %s %s\n", theme.Selected.Render(spinner), theme.Body.Render("Scanning host..."))
	body += fmt.Sprintf("  %s %s\n", theme.Selected.Render(spinner), theme.Dim.Render("Querying storage pools..."))
	body += fmt.Sprintf("  %s %s\n", theme.Selected.Render(spinner), theme.Dim.Render("Detecting network bridges..."))

	// Indeterminate bar
	barW := 30
	pos := d.frame % (barW * 2)
	if pos >= barW {
		pos = barW*2 - pos
	}
	bar := ""
	for i := 0; i < barW; i++ {
		if i >= pos-2 && i <= pos+2 {
			bar += "█"
		} else {
			bar += "░"
		}
	}
	barStyled := lipgloss.NewStyle().Foreground(theme.Amber).Render("[" + bar + "]")
	body += "\n" + barStyled

	boxed := theme.Box.Render(body)
	if d.width > 0 {
		return lipgloss.Place(d.width, d.height, lipgloss.Center, lipgloss.Center, boxed)
	}
	return boxed
}

func (d detectModel) viewError() string {
	title := theme.Title.Render("  Detection Error")
	errMsg := theme.Danger.Render("  " + d.err.Error())
	hint := theme.Hint.Render("  Press any key to return to menu")

	body := title + "\n\n" + errMsg + "\n\n" + hint
	boxed := theme.Box.Render(body)
	if d.width > 0 {
		return lipgloss.Place(d.width, d.height, lipgloss.Center, lipgloss.Center, boxed)
	}
	return boxed
}

func (d detectModel) viewReveal() string {
	title := theme.Title.Render("  Detecting environment...")
	lines := d.lines()

	var rows []string
	for i, l := range lines {
		if i >= d.revealed {
			// Scanning line — not yet revealed
			spinner := []string{"◐", "◓", "◑", "◒"}[d.frame%4]
			row := fmt.Sprintf("  %s %s",
				theme.Selected.Render(spinner),
				theme.Dim.Render(l.label+"..."))
			rows = append(rows, row)
			break
		}
		var marker string
		switch l.status {
		case "ok":
			marker = lipgloss.NewStyle().Foreground(theme.NeonGreen).Render("✓")
		case "warn":
			marker = lipgloss.NewStyle().Foreground(theme.Amber).Render("~")
		case "fail":
			marker = lipgloss.NewStyle().Foreground(theme.Danger.GetForeground()).Render("✗")
		default:
			marker = theme.Dim.Render("·")
		}
		val := theme.Body.Render(l.value)
		lbl := theme.Dim.Render(l.label)
		row := fmt.Sprintf("  %s %-20s %s", marker, lbl, val)
		rows = append(rows, row)
	}

	// Progress bar
	pct := 0
	if len(lines) > 0 {
		pct = (d.revealed * 100) / len(lines)
	}
	barW := 30
	filled := (barW * pct) / 100
	bar := lipgloss.NewStyle().Foreground(theme.Amber).Render(
		"[" + repeatStr("█", filled) + repeatStr("░", barW-filled) + "]",
	)
	pctStr := theme.Body.Render(fmt.Sprintf(" %d%%", pct))

	body := title + "\n\n"
	for _, r := range rows {
		body += r + "\n"
	}
	body += "\n" + bar + pctStr

	// Warnings
	if d.revealed >= len(lines) && len(d.env.Warnings) > 0 {
		body += "\n"
		for _, w := range d.env.Warnings {
			body += "\n" + lipgloss.NewStyle().Foreground(theme.Amber).Render("  ⚠ "+w)
		}
	}

	// Fatal: running inside a container
	if d.revealed >= len(lines) && d.env.IsContainer {
		body += "\n\n" + theme.Danger.Render("  Cannot install YouEye inside a container.")
		body += "\n" + theme.Hint.Render("  Run the installer on the Proxmox host or a bare Linux machine.")
		body += "\n" + theme.Hint.Render("  Press any key to return to menu")
	} else {
		hint := theme.Hint.Render("  Press any key to continue...")
		body += "\n\n" + hint
	}

	boxed := theme.Box.Render(body)
	if d.width > 0 {
		return lipgloss.Place(d.width, d.height, lipgloss.Center, lipgloss.Center, boxed)
	}
	return boxed
}

func repeatStr(s string, n int) string {
	out := ""
	for i := 0; i < n; i++ {
		out += s
	}
	return out
}
