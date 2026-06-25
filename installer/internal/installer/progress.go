package installer

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/progress"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/youeye-platform/YouEye/installer/internal/installer/tetris"
	"github.com/youeye-platform/YouEye/installer/internal/installer/theme"
)

// ---------------------------------------------------------------------------
// Engine channel listener (bridges goroutine → Bubble Tea)
// ---------------------------------------------------------------------------

func listenEngine(ch <-chan engineMsg) tea.Cmd {
	return func() tea.Msg {
		msg, ok := <-ch
		if !ok {
			return engineMsg{Done: true}
		}
		return msg
	}
}

// ---------------------------------------------------------------------------
// Progress model
// ---------------------------------------------------------------------------

type progressModel struct {
	width, height int

	// Pre-install confirmation — user must press Enter to begin.
	// When autoStart is true, the engine starts immediately in Init()
	// and the readyView is skipped entirely.
	ready     bool
	autoStart bool

	// Engine state
	engineCh <-chan engineMsg
	stepName string
	percent  float64
	lastLog  string // single most-recent meaningful log line

	bar progress.Model

	tetrisM tetris.Model

	done     bool
	err      error
	resultIP string
	config   installConfig
}

func newProgressModel(config installConfig) progressModel {
	pb := progress.New(progress.WithDefaultGradient(), progress.WithoutPercentage())
	pb.Width = 60

	return progressModel{
		ready:    true,
		config:   config,
		stepName: "Starting installation...",
		bar:      pb,
		tetrisM:  tetris.New(),
	}
}

func (p progressModel) Init() tea.Cmd {
	// When autoStart is true, the caller must have already started the
	// engine and set p.engineCh before calling Init(). We only return
	// the listener command here — we cannot set engineCh ourselves
	// because Init() is a value receiver and changes would be lost.
	if p.autoStart && p.engineCh != nil {
		return tea.Batch(listenEngine(p.engineCh), p.tetrisM.Init())
	}
	return nil // engine starts when user presses Enter
}

func (p progressModel) Update(msg tea.Msg) (progressModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		p.width, p.height = msg.Width, msg.Height
		p.bar.Width = p.width - 20
		if p.bar.Width < 20 {
			p.bar.Width = 20
		}
		if p.bar.Width > 80 {
			p.bar.Width = 80
		}
		return p, nil

	case engineMsg:
		return p.handleEngine(msg)

	case tea.KeyMsg:
		key := msg.String()

		// Pre-install screen: Enter starts installation
		if p.ready {
			if key == "enter" {
				p.ready = false
				p.engineCh = startEngine(p.config)
				return p, tea.Batch(listenEngine(p.engineCh), p.tetrisM.Init())
			}
			return p, nil
		}

		// q/esc — installer handles quit (don't propagate to games)
		if key == "q" || key == "esc" {
			return p, nil
		}

		var cmd tea.Cmd
		p.tetrisM, cmd = p.tetrisM.Update(msg)
		return p, cmd

	case progress.FrameMsg:
		var pm tea.Model
		pm, cmd := p.bar.Update(msg)
		p.bar = pm.(progress.Model)
		return p, cmd

	// Intercept game quit messages so they don't bubble up
	case tetris.QuitMsg:
		return p, nil

	default:
		var cmd tea.Cmd
		p.tetrisM, cmd = p.tetrisM.Update(msg)
		return p, cmd
	}
}

func (p progressModel) handleEngine(msg engineMsg) (progressModel, tea.Cmd) {
	if msg.Err != nil {
		p.err = msg.Err
		p.done = true
		return p, nil
	}
	if msg.Done {
		p.done = true
		p.resultIP = msg.ResultIP
		p.percent = 1.0
		p.stepName = "Installation complete"
		p.lastLog = "YouEye installed successfully"
		cmd := p.bar.SetPercent(1.0)
		return p, cmd
	}

	if msg.StepName != "" {
		p.stepName = msg.StepName
	}
	if msg.LogLine != "" {
		p.lastLog = msg.LogLine
	}
	if msg.Percent > p.percent {
		p.percent = msg.Percent
	}

	barCmd := p.bar.SetPercent(p.percent)
	return p, tea.Batch(listenEngine(p.engineCh), barCmd)
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

func (p progressModel) View() string {
	// --- Pre-install confirmation screen ---
	if p.ready {
		return p.readyView()
	}

	gameView := p.tetrisM.View()

	// --- Step indicator + last log ---
	stepLine := ""
	if p.err != nil {
		stepLine = theme.Danger.Render("✗ ERROR: " + p.err.Error())
	} else if p.done {
		stepLine = lipgloss.NewStyle().Foreground(theme.NeonGreen).Bold(true).Render("✓ ") +
			theme.Body.Render(p.stepName)
	} else {
		spinChars := []string{"◐", "◓", "◑", "◒"}
		frame := int(p.percent * 100)
		sp := spinChars[frame%4]
		stepLine = theme.Selected.Render(sp) + " " + theme.Body.Render(p.stepName)
	}

	// Single status line (not a scrolling log)
	statusLine := ""
	if p.lastLog != "" {
		logText := p.lastLog
		if len(logText) > 70 {
			logText = logText[:67] + "..."
		}
		statusLine = theme.Dim.Render("  " + logText)
	}

	// --- Progress bar ---
	pct := int(p.percent * 100)
	pbar := lipgloss.JoinHorizontal(
		lipgloss.Center,
		theme.StatusBar.Render(fmt.Sprintf(" %3d%% ", pct)),
		" ",
		p.bar.View(),
	)

	// --- Hints ---
	hint := theme.Hint.Render("q quit")
	if p.done && p.err == nil {
		hint = theme.Selected.Render(" ✓ installation complete — press Enter to continue ")
	} else if p.err != nil {
		hint = theme.Danger.Render(" Installation failed — press Enter to see details ")
	}

	// --- Divider ---
	divider := theme.Dim.Render(strings.Repeat("─", 60))

	// --- Layout: game on top, compact status on bottom ---
	content := lipgloss.JoinVertical(lipgloss.Left,
		gameView,
		divider,
		stepLine,
		statusLine,
		pbar,
		hint,
	)

	if p.width > 0 {
		return lipgloss.Place(p.width, p.height, lipgloss.Center, lipgloss.Center, content)
	}
	return content
}

// readyView renders the pre-install confirmation screen.
func (p progressModel) readyView() string {
	check := lipgloss.NewStyle().Foreground(theme.NeonGreen).Bold(true)

	var rows []string
	rows = append(rows,
		"",
		check.Render("  ▸ Install YouEye"),
		"",
	)

	// Show config summary
	switch p.config.Mode {
	case modeLXC:
		rows = append(rows, theme.Body.Render(fmt.Sprintf("  Mode:       LXC Container")))
		rows = append(rows, theme.Body.Render(fmt.Sprintf("  ID:         %s (%s)", p.config.ContainerID, p.config.Hostname)))
	case modeVM:
		rows = append(rows, theme.Body.Render(fmt.Sprintf("  Mode:       Virtual Machine")))
		rows = append(rows, theme.Body.Render(fmt.Sprintf("  ID:         %s (%s)", p.config.ContainerID, p.config.Hostname)))
	case modeHost:
		rows = append(rows, theme.Body.Render(fmt.Sprintf("  Mode:       Direct install on this host")))
	}
	rows = append(rows, theme.Body.Render(fmt.Sprintf("  Core repo:  %s", p.config.CoreRepoURL)))
	rows = append(rows, theme.Body.Render(fmt.Sprintf("  Market:     %s", p.config.MarketRepoURL)))
	rows = append(rows, theme.Body.Render(fmt.Sprintf("  Channel:    %s", p.config.ReleaseChannel)))

	if p.config.Mode != modeHost {
		rows = append(rows, theme.Body.Render(fmt.Sprintf("  Resources:  %d CPU · %d MB RAM · %d GB disk", p.config.CPUCores, p.config.RAMMB, p.config.DiskGB)))
		net := p.config.IPMode
		if p.config.NetworkBridge != "" {
			net += " via " + p.config.NetworkBridge
		}
		rows = append(rows, theme.Body.Render(fmt.Sprintf("  Network:    %s", net)))
		rows = append(rows, theme.Body.Render(fmt.Sprintf("  Storage:    %s", p.config.StoragePool)))
	}

	rows = append(rows, "")
	rows = append(rows, theme.Selected.Render("  [ Press Enter to install ]"))
	rows = append(rows, theme.Dim.Render("    q/esc to go back"))
	rows = append(rows, "")

	body := strings.Join(rows, "\n")
	boxed := theme.BoxAccent.Render(body)

	if p.width > 0 {
		return lipgloss.Place(p.width, p.height, lipgloss.Center, lipgloss.Center, boxed)
	}
	return boxed
}
