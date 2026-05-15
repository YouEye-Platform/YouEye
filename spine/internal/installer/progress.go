package installer

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/progress"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"git.byka.wtf/potemsla/YouEye/spine/internal/installer/pong"
	"git.byka.wtf/potemsla/YouEye/spine/internal/installer/snake"
	"git.byka.wtf/potemsla/YouEye/spine/internal/installer/tetris"
	"git.byka.wtf/potemsla/YouEye/spine/internal/installer/theme"
	"git.byka.wtf/potemsla/YouEye/spine/internal/installer/twofortyeight"
)

// ---------------------------------------------------------------------------
// Active game enum
// ---------------------------------------------------------------------------

type activeGame int

const (
	gameSnake activeGame = iota
	gamePong
	gameTetris
	game2048
)

var gameNames = []string{"Snake", "Pong", "Tetris", "2048"}

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

	// Games
	activeGame  activeGame
	gameStarted bool
	snakeM      snake.Model
	pongM       pong.Model
	tetrisM     tetris.Model
	twoKM       twofortyeight.Model

	done     bool
	err      error
	resultIP string
	config   installConfig
}

func newProgressModel(config installConfig) progressModel {
	pb := progress.New(progress.WithDefaultGradient(), progress.WithoutPercentage())
	pb.Width = 60

	return progressModel{
		ready:      true,
		config:     config,
		stepName:   "Starting installation...",
		bar:        pb,
		snakeM:     snake.New(20, 12, true),
		pongM:      pong.New(),
		tetrisM:    tetris.New(),
		twoKM:      twofortyeight.New(),
		activeGame: gameTetris,
	}
}

func (p progressModel) Init() tea.Cmd {
	// When autoStart is true, the caller must have already started the
	// engine and set p.engineCh before calling Init(). We only return
	// the listener command here — we cannot set engineCh ourselves
	// because Init() is a value receiver and changes would be lost.
	if p.autoStart && p.engineCh != nil {
		return listenEngine(p.engineCh)
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
				return p, listenEngine(p.engineCh)
			}
			return p, nil
		}

		// Game switcher: number keys 1-4
		switch key {
		case "1":
			p.activeGame = gameSnake
			p.gameStarted = false
			return p, nil
		case "2":
			p.activeGame = gamePong
			p.gameStarted = false
			return p, nil
		case "3":
			p.activeGame = gameTetris
			p.gameStarted = false
			return p, nil
		case "4":
			p.activeGame = game2048
			p.gameStarted = false
			return p, nil
		}

		// q/esc — installer handles quit (don't propagate to games)
		if key == "q" || key == "esc" {
			return p, nil
		}

		// If game not started yet, any gameplay key starts it
		if !p.gameStarted {
			if isGameplayKey(key) {
				p.gameStarted = true
				switch p.activeGame {
				case gameSnake:
					p.snakeM = snake.New(20, 12, true)
					return p, p.snakeM.Init()
				case gamePong:
					p.pongM = pong.New()
					return p, p.pongM.Init()
				case gameTetris:
					p.tetrisM = tetris.New()
					return p, p.tetrisM.Init()
				case game2048:
					p.twoKM = twofortyeight.New()
					return p, p.twoKM.Init()
				}
			}
			return p, nil
		}

		// Forward gameplay keys to active game
		return p.forwardToGame(msg)

	case progress.FrameMsg:
		var pm tea.Model
		pm, cmd := p.bar.Update(msg)
		p.bar = pm.(progress.Model)
		return p, cmd

	// Intercept game quit messages so they don't bubble up
	case snake.QuitMsg:
		return p, nil
	case pong.QuitMsg:
		return p, nil
	case tetris.QuitMsg:
		return p, nil
	case twofortyeight.QuitMsg:
		return p, nil

	default:
		// Forward game ticks to active game only if started
		if p.gameStarted {
			return p.forwardToGame(msg)
		}
		return p, nil
	}
}

// isGameplayKey returns true for keys that should start a game.
func isGameplayKey(key string) bool {
	switch key {
	case "up", "down", "left", "right",
		"w", "a", "s", "d",
		" ", "enter":
		return true
	}
	return false
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

func (p progressModel) forwardToGame(msg tea.Msg) (progressModel, tea.Cmd) {
	var cmd tea.Cmd
	switch p.activeGame {
	case gameSnake:
		p.snakeM, cmd = p.snakeM.Update(msg)
	case gamePong:
		p.pongM, cmd = p.pongM.Update(msg)
	case gameTetris:
		p.tetrisM, cmd = p.tetrisM.Update(msg)
	case game2048:
		p.twoKM, cmd = p.twoKM.Update(msg)
	}
	return p, cmd
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

func (p progressModel) View() string {
	// --- Pre-install confirmation screen ---
	if p.ready {
		return p.readyView()
	}

	// --- Game picker tabs ---
	gamePicker := " Play while you wait:  "
	for i, name := range gameNames {
		if activeGame(i) == p.activeGame {
			gamePicker += theme.Selected.Render(fmt.Sprintf("[%d:%s]", i+1, name)) + " "
		} else {
			gamePicker += theme.Dim.Render(fmt.Sprintf(" %d:%s ", i+1, name)) + " "
		}
	}

	// --- Game view ---
	var gameView string
	if !p.gameStarted {
		gameName := gameNames[int(p.activeGame)]
		gameView = "\n\n" +
			theme.Dim.Render(fmt.Sprintf("    %s — press arrow keys or WASD to start", gameName)) +
			"\n\n"
	} else {
		switch p.activeGame {
		case gameSnake:
			gameView = p.snakeM.View()
		case gamePong:
			gameView = p.pongM.View()
		case gameTetris:
			gameView = p.tetrisM.View()
		case game2048:
			gameView = p.twoKM.View()
		}
	}

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
	hint := theme.Hint.Render("1-4 switch game · wasd/arrows play · q quit")
	if p.done && p.err == nil {
		hint = theme.Selected.Render(" ✓ installation complete — press Enter to continue ")
	} else if p.err != nil {
		hint = theme.Danger.Render(" Installation failed — press Enter to see details ")
	}

	// --- Divider ---
	divider := theme.Dim.Render(strings.Repeat("─", 60))

	// --- Layout: game on top, compact status on bottom ---
	content := lipgloss.JoinVertical(lipgloss.Left,
		gamePicker,
		"",
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
