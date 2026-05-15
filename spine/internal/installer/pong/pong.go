// Package pong implements a single-player Pong variant: human on the left,
// CPU on the right. Keyboard controls the paddle with W/S or ↑/↓; the
// mouse can also drive the paddle's Y position when in mouse-tracking mode
// (the paddle snaps to the cursor's Y row anywhere over the playfield).
//
// First side to 7 wins.
package pong

import (
	"fmt"
	"math/rand/v2"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"git.byka.wtf/potemsla/YouEye/spine/internal/installer/theme"
)

// QuitMsg returns control to the menu.
type QuitMsg struct{}

// frameMsg is the per-tick physics signal.
type frameMsg struct{ epoch int }

const (
	fieldW       = 60
	fieldH       = 20
	paddleH      = 4
	winScore     = 7
	frameMs      = 35  // physics tick — ~28 fps
	cpuMaxSpeed  = 1   // CPU paddle moves up to 1 row per tick
	playerMaxSpd = 2   // human paddle moves up to 2 rows per tick
)

// Model holds Pong state.
type Model struct {
	// Paddle Y is the top row of the paddle; range [0, fieldH-paddleH].
	pPaddleY int
	cPaddleY int

	// Ball position (float for sub-cell accuracy) and velocity.
	bx, by, vx, vy float64

	pScore, cScore int
	gameOver       bool
	winner         string // "you" / "cpu"
	paused         bool

	// Movement input from this tick. We reset every frame so holds keep
	// pushing.
	playerVel int

	epoch int
	rng   *rand.Rand
}

// New creates a fresh game.
func New() Model {
	m := Model{
		pPaddleY: fieldH/2 - paddleH/2,
		cPaddleY: fieldH/2 - paddleH/2,
		rng:      rand.New(rand.NewPCG(uint64(time.Now().UnixNano()), 0xBADCAB)),
	}
	m.serve(true)
	return m
}

// serve places the ball at center moving toward `toCPU` if true, otherwise
// toward the player.
func (m *Model) serve(toCPU bool) {
	m.bx = float64(fieldW) / 2
	m.by = float64(fieldH) / 2
	speed := 0.6
	if toCPU {
		m.vx = speed
	} else {
		m.vx = -speed
	}
	// Random vertical bias so consecutive serves vary.
	m.vy = (m.rng.Float64() - 0.5) * 0.6
}

// Init schedules the first frame.
func (m Model) Init() tea.Cmd { return m.frameCmd() }

func (m Model) frameCmd() tea.Cmd {
	return tea.Tick(frameMs*time.Millisecond, func(t time.Time) tea.Msg {
		_ = t
		return frameMsg{epoch: m.epoch}
	})
}

// clamp paddle Y into legal range.
func clampPaddle(y int) int {
	if y < 0 {
		return 0
	}
	if y > fieldH-paddleH {
		return fieldH - paddleH
	}
	return y
}

// stepPhysics advances the world one frame.
func (m *Model) stepPhysics() {
	if m.paused || m.gameOver {
		return
	}

	// Player paddle responds to held input.
	m.pPaddleY = clampPaddle(m.pPaddleY + m.playerVel)
	m.playerVel = 0

	// CPU paddle: chase the ball with a small reaction lag — perfect AI is
	// no fun. We move at most cpuMaxSpeed per tick.
	cpuCenter := m.cPaddleY + paddleH/2
	target := int(m.by)
	if target < cpuCenter {
		m.cPaddleY -= cpuMaxSpeed
	} else if target > cpuCenter {
		m.cPaddleY += cpuMaxSpeed
	}
	m.cPaddleY = clampPaddle(m.cPaddleY)

	// Move ball.
	m.bx += m.vx
	m.by += m.vy

	// Top/bottom wall bounce.
	if m.by < 0 {
		m.by = 0
		m.vy = -m.vy
	} else if m.by > float64(fieldH-1) {
		m.by = float64(fieldH - 1)
		m.vy = -m.vy
	}

	// Paddle collisions. Player paddle sits at column 1; CPU at fieldW-2.
	bxi := int(m.bx)
	byi := int(m.by)

	if bxi <= 1 && m.vx < 0 {
		if byi >= m.pPaddleY && byi < m.pPaddleY+paddleH {
			m.vx = -m.vx
			// Add english based on where the ball hit on the paddle.
			offset := float64(byi-m.pPaddleY) - float64(paddleH-1)/2
			m.vy += offset * 0.25
			// Speed up gradually.
			m.vx *= 1.05
			m.bx = 2
		} else if bxi < 0 {
			// Goal for CPU.
			m.cScore++
			if m.cScore >= winScore {
				m.gameOver = true
				m.winner = "cpu"
			} else {
				m.serve(false)
			}
		}
	}
	if bxi >= fieldW-2 && m.vx > 0 {
		if byi >= m.cPaddleY && byi < m.cPaddleY+paddleH {
			m.vx = -m.vx
			offset := float64(byi-m.cPaddleY) - float64(paddleH-1)/2
			m.vy += offset * 0.25
			m.vx *= 1.05
			m.bx = float64(fieldW - 3)
		} else if bxi >= fieldW {
			m.pScore++
			if m.pScore >= winScore {
				m.gameOver = true
				m.winner = "you"
			} else {
				m.serve(true)
			}
		}
	}
	// Velocity cap so the ball stays trackable.
	if m.vx > 1.6 {
		m.vx = 1.6
	} else if m.vx < -1.6 {
		m.vx = -1.6
	}
}

// Update routes messages.
func (m Model) Update(msg tea.Msg) (Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "up", "w":
			m.playerVel = -playerMaxSpd
		case "down", "s":
			m.playerVel = playerMaxSpd
		case "p":
			m.paused = !m.paused
		case "r":
			n := New()
			return n, n.Init()
		case "q", "esc":
			return m, func() tea.Msg { return QuitMsg{} }
		}
		return m, nil

	case tea.MouseMsg:
		// Mouse motion drives the paddle Y. We treat the cursor's row
		// (offset by the header row) as the paddle's middle.
		if msg.Action == tea.MouseActionMotion {
			// The playfield's first row in the parent's view is roughly 3
			// (header + spacer + box-top). Approximate; doesn't need to
			// be exact because clampPaddle keeps things sane.
			rel := msg.Y - 3
			target := rel - paddleH/2
			m.pPaddleY = clampPaddle(target)
		}
		return m, nil

	case frameMsg:
		if msg.epoch != m.epoch {
			return m, nil
		}
		m.stepPhysics()
		return m, m.frameCmd()
	}
	return m, nil
}

// View renders the field, paddles, ball, and scoreboard.
func (m Model) View() string {
	header := theme.Title.Render("PONG — you vs the machine") +
		theme.Hint.Render(fmt.Sprintf("   first to %d wins", winScore))

	// Build a 2D character buffer for the field.
	rows := make([][]rune, fieldH)
	for i := range rows {
		rows[i] = make([]rune, fieldW)
		for x := range rows[i] {
			rows[i][x] = ' '
		}
	}
	// Center net.
	for y := 0; y < fieldH; y++ {
		if y%2 == 0 {
			rows[y][fieldW/2] = '│'
		}
	}
	// Paddles.
	for i := 0; i < paddleH; i++ {
		if m.pPaddleY+i >= 0 && m.pPaddleY+i < fieldH {
			rows[m.pPaddleY+i][1] = '█'
		}
		if m.cPaddleY+i >= 0 && m.cPaddleY+i < fieldH {
			rows[m.cPaddleY+i][fieldW-2] = '█'
		}
	}
	// Ball.
	bxi := int(m.bx)
	byi := int(m.by)
	if bxi >= 0 && bxi < fieldW && byi >= 0 && byi < fieldH {
		rows[byi][bxi] = '●'
	}

	// Style each character — paddles amber, ball magenta, net dim.
	paddleStyle := lipgloss.NewStyle().Foreground(theme.Amber).Bold(true)
	ballStyle := lipgloss.NewStyle().Foreground(theme.Magenta).Bold(true)
	netStyle := lipgloss.NewStyle().Foreground(theme.AmberDim)

	var lines []string
	for _, row := range rows {
		var sb strings.Builder
		for _, ch := range row {
			switch ch {
			case '█':
				sb.WriteString(paddleStyle.Render(string(ch)))
			case '●':
				sb.WriteString(ballStyle.Render(string(ch)))
			case '│':
				sb.WriteString(netStyle.Render(string(ch)))
			default:
				sb.WriteRune(ch)
			}
		}
		lines = append(lines, sb.String())
	}
	field := strings.Join(lines, "\n")

	score := lipgloss.NewStyle().Foreground(theme.Amber).Bold(true).Render(
		fmt.Sprintf("YOU  %d  ·  %d  CPU", m.pScore, m.cScore))

	hint := theme.Hint.Render("w/s or ↑/↓ (or move mouse) · p pause · r restart · q quit")

	if m.gameOver {
		who := "you win!"
		if m.winner == "cpu" {
			who = "cpu wins."
		}
		hint = theme.Selected.Render(fmt.Sprintf(" GAME OVER — %s  press r to play again, q to quit ", who))
	} else if m.paused {
		hint = theme.Selected.Render(" PAUSED — press p to resume ")
	}

	return lipgloss.JoinVertical(lipgloss.Center,
		header,
		score,
		"",
		theme.Box.Render(field),
		"",
		hint,
	)
}
