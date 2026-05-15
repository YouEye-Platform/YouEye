package installer

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"git.byka.wtf/potemsla/YouEye/spine/internal/installer/theme"
)

// completeModel shows the post-install summary.
type completeModel struct {
	width, height int
	config        installConfig
}

func newCompleteModel(config installConfig) completeModel {
	return completeModel{config: config}
}

func (c completeModel) Init() tea.Cmd { return nil }

func (c completeModel) Update(msg tea.Msg) (completeModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		c.width, c.height = msg.Width, msg.Height
	}
	return c, nil
}

func (c completeModel) View() string {
	cfg := c.config

	// Determine the URL to display
	address := cfg.ResultIP
	if address == "" {
		// Fallback: use hostname or static IP
		address = cfg.Hostname
		if cfg.IPMode == "Static" && cfg.StaticIP != "" {
			address = strings.Split(cfg.StaticIP, "/")[0]
		}
	}

	url := fmt.Sprintf("https://%s", address)
	target := fmt.Sprintf("%s (%s)", cfg.ContainerID, cfg.Hostname)
	resources := fmt.Sprintf("%d CPU / %d MB / %d GB", cfg.CPUCores, cfg.RAMMB, cfg.DiskGB)

	checkMark := lipgloss.NewStyle().Foreground(theme.NeonGreen).Bold(true).Render("✓")

	var rows []string
	rows = append(rows,
		"",
		fmt.Sprintf("         %s  YouEye is ready!", checkMark),
		"",
	)

	// URL on its own line, plain text so it's easy to select/copy
	rows = append(rows, fmt.Sprintf("  Open in browser:"))
	rows = append(rows, "")
	rows = append(rows, fmt.Sprintf("    %s", url))
	rows = append(rows, "")

	rows = append(rows, fmt.Sprintf("  Username:   %s", "admin"))

	pw := "(none — auto-login)"
	if cfg.RootPassword != "" {
		pw = "(the one you set)"
	}
	rows = append(rows, fmt.Sprintf("  Password:   %s", theme.Dim.Render(pw)))
	rows = append(rows, "")

	if cfg.Mode != modeHost {
		rows = append(rows, fmt.Sprintf("  %s:   %s", cfg.Mode, target))
	}
	rows = append(rows, fmt.Sprintf("  Resources:  %s", resources))

	if cfg.ResultIP != "" {
		rows = append(rows, fmt.Sprintf("  IP Address: %s", cfg.ResultIP))
	}

	rows = append(rows, "")
	rows = append(rows, theme.Dim.Render("  Your browser may show a certificate warning — this is"))
	rows = append(rows, theme.Dim.Render("  expected for self-signed TLS. Accept it to continue."))
	rows = append(rows, "")
	rows = append(rows, theme.Hint.Render("  Press Enter to exit"))
	rows = append(rows, "")

	body := strings.Join(rows, "\n")
	boxed := theme.BoxAccent.Render(body)

	if c.width > 0 {
		return lipgloss.Place(c.width, c.height, lipgloss.Center, lipgloss.Center, boxed)
	}
	return boxed
}

// ---------------------------------------------------------------------------
// Error screen — shown when installation fails
// ---------------------------------------------------------------------------

type errorModel struct {
	width, height int
	err           error
	config        installConfig
}

func newErrorModel(config installConfig, err error) errorModel {
	return errorModel{config: config, err: err}
}

func (e errorModel) Init() tea.Cmd { return nil }

func (e errorModel) Update(msg tea.Msg) (errorModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		e.width, e.height = msg.Width, msg.Height
	}
	return e, nil
}

func (e errorModel) View() string {
	x := lipgloss.NewStyle().Foreground(theme.Red).Bold(true).Render("✗")

	var rows []string
	rows = append(rows,
		"",
		fmt.Sprintf("         %s  Installation Failed", x),
		"",
	)

	// Error message (wrap long lines)
	errStr := e.err.Error()
	errLines := wrapText(errStr, 60)
	for _, line := range errLines {
		rows = append(rows, "  "+theme.Danger.Render(line))
	}

	rows = append(rows, "")

	// Context
	rows = append(rows, theme.Dim.Render(fmt.Sprintf("  Mode: %s", e.config.Mode)))
	if e.config.Mode != modeHost {
		rows = append(rows, theme.Dim.Render(fmt.Sprintf("  ID:   %s (%s)", e.config.ContainerID, e.config.Hostname)))
	}

	rows = append(rows, "")

	// Cleanup hint
	if e.config.Mode == modeLXC {
		rows = append(rows, theme.Dim.Render(fmt.Sprintf("  To clean up: pct destroy %s --purge", e.config.ContainerID)))
	} else if e.config.Mode == modeVM {
		rows = append(rows, theme.Dim.Render(fmt.Sprintf("  To clean up: qm destroy %s --purge", e.config.ContainerID)))
	}

	rows = append(rows, "")
	rows = append(rows, theme.Hint.Render("  Press Enter to exit"))
	rows = append(rows, "")

	body := strings.Join(rows, "\n")
	boxed := theme.Box.Render(body)

	if e.width > 0 {
		return lipgloss.Place(e.width, e.height, lipgloss.Center, lipgloss.Center, boxed)
	}
	return boxed
}

// wrapText breaks a string into lines of at most width characters.
func wrapText(s string, width int) []string {
	if len(s) <= width {
		return []string{s}
	}
	var lines []string
	for len(s) > width {
		// Find last space within width
		cut := width
		for cut > 0 && s[cut] != ' ' {
			cut--
		}
		if cut == 0 {
			cut = width // no space found, hard break
		}
		lines = append(lines, s[:cut])
		s = strings.TrimLeft(s[cut:], " ")
	}
	if len(s) > 0 {
		lines = append(lines, s)
	}
	return lines
}
