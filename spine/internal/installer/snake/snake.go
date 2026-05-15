// Package snake is a Bubble Tea sub-component implementing the classic
// game. It is designed to work in two modes:
//
//   - Standalone: full-screen, with its own header/footer (used from the menu).
//     The grid auto-resizes to fill the terminal on every WindowSizeMsg.
//   - Embedded:   sized by a parent (used inside the installer progress view).
//
// Input model: direction changes are applied IMMEDIATELY (with an instant
// step + tick reset) so there's no perceptible lag between pressing a key
// and the snake turning. The standard tick rate then carries the new
// direction forward at normal speed.
package snake

import (
	"fmt"
	"math/rand/v2"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"git.byka.wtf/potemsla/YouEye/spine/internal/installer/theme"
)

type direction int

const (
	dirUp direction = iota
	dirDown
	dirLeft
	dirRight
)

// QuitMsg is emitted when the standalone snake wants to return to the menu.
type QuitMsg struct{}

// tickMsg is the periodic movement signal. It carries an epoch so that an
// "early" tick triggered by an instant direction change can invalidate any
// in-flight scheduled tick — preventing double-stepping.
type tickMsg struct {
	epoch int
}

// tickEvery returns a tea.Cmd that fires after `interval`, tagged with epoch.
func tickEvery(epoch int, interval time.Duration) tea.Cmd {
	return tea.Tick(interval, func(t time.Time) tea.Msg {
		_ = t
		return tickMsg{epoch: epoch}
	})
}

type cell struct{ X, Y int }

// Model holds snake state.
type Model struct {
	GridW, GridH int

	snake    []cell
	dir      direction
	pendDir  direction
	food     cell
	score    int
	gameOver bool
	paused   bool
	speed    time.Duration

	// epoch increments every time we issue a "fresh" tick that should
	// supersede any scheduled tick still in flight. Older ticks are dropped
	// in Update.
	epoch int

	embedded bool
	rng      *rand.Rand
}

// New constructs a snake at the given grid size.
func New(w, h int, embedded bool) Model {
	if w < 10 {
		w = 10
	}
	if h < 8 {
		h = 8
	}
	m := Model{
		GridW:    w,
		GridH:    h,
		dir:      dirRight,
		pendDir:  dirRight,
		speed:    100 * time.Millisecond,
		embedded: embedded,
		rng:      rand.New(rand.NewPCG(uint64(time.Now().UnixNano()), 0xDEADBEEF)),
	}
	m.reset()
	return m
}

// reset restores starting conditions.
func (m *Model) reset() {
	startX, startY := m.GridW/2, m.GridH/2
	m.snake = []cell{
		{startX - 2, startY},
		{startX - 1, startY},
		{startX, startY},
	}
	m.dir = dirRight
	m.pendDir = dirRight
	m.score = 0
	m.gameOver = false
	m.paused = false
	m.speed = 100 * time.Millisecond
	m.spawnFood()
}

// Resize rebuilds the playing field for a new terminal size. Called by the
// parent when WindowSizeMsg arrives.
func (m *Model) Resize(gridW, gridH int) {
	if gridW < 10 {
		gridW = 10
	}
	if gridH < 8 {
		gridH = 8
	}
	m.GridW, m.GridH = gridW, gridH
	// If existing snake/food fall outside the new grid, reset.
	for _, s := range m.snake {
		if s.X >= gridW || s.Y >= gridH {
			m.reset()
			return
		}
	}
	if m.food.X >= gridW || m.food.Y >= gridH {
		m.spawnFood()
	}
}

// spawnFood places food on a random non-snake cell.
func (m *Model) spawnFood() {
	for tries := 0; tries < 100; tries++ {
		c := cell{m.rng.IntN(m.GridW), m.rng.IntN(m.GridH)}
		clash := false
		for _, s := range m.snake {
			if s == c {
				clash = true
				break
			}
		}
		if !clash {
			m.food = c
			return
		}
	}
	// Fallback for absurdly long snake on a tiny grid.
	m.food = cell{0, 0}
}

// Init starts the tick loop.
func (m Model) Init() tea.Cmd { return tickEvery(m.epoch, m.speed) }

// step advances the snake one cell in m.pendDir. Returns true if the game
// continues, false on death.
func (m *Model) step() bool {
	m.dir = m.pendDir
	head := m.snake[len(m.snake)-1]
	switch m.dir {
	case dirUp:
		head.Y--
	case dirDown:
		head.Y++
	case dirLeft:
		head.X--
	case dirRight:
		head.X++
	}
	if head.X < 0 || head.X >= m.GridW || head.Y < 0 || head.Y >= m.GridH {
		m.gameOver = true
		return false
	}
	for _, s := range m.snake {
		if s == head {
			m.gameOver = true
			return false
		}
	}
	m.snake = append(m.snake, head)
	if head == m.food {
		m.score++
		// Speed up gently — never below 50ms.
		if m.speed > 50*time.Millisecond {
			m.speed -= 4 * time.Millisecond
		}
		m.spawnFood()
	} else {
		m.snake = m.snake[1:]
	}
	return true
}

// Update handles one frame.
func (m Model) Update(msg tea.Msg) (Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		// Determine requested new direction (if any).
		var requested direction = -1
		switch msg.String() {
		case "up", "w":
			if m.dir != dirDown {
				requested = dirUp
			}
		case "down", "s":
			if m.dir != dirUp {
				requested = dirDown
			}
		case "left", "a":
			if m.dir != dirRight {
				requested = dirLeft
			}
		case "right", "d":
			if m.dir != dirLeft {
				requested = dirRight
			}
		case "p":
			m.paused = !m.paused
			return m, nil
		case "r":
			m.reset()
			m.epoch++
			return m, tickEvery(m.epoch, m.speed)
		case "q", "esc":
			if !m.embedded {
				return m, func() tea.Msg { return QuitMsg{} }
			}
		}

		if requested >= 0 && !m.gameOver && !m.paused {
			// Apply the new direction immediately + step + reset the tick.
			// This is what kills input lag: instead of waiting up to one
			// tick interval for the next scheduled movement, we step right
			// now and start a fresh tick from this moment.
			m.pendDir = requested
			m.step()
			m.epoch++
			return m, tickEvery(m.epoch, m.speed)
		}
		return m, nil

	case tickMsg:
		// Drop ticks from a previous epoch — they were superseded by an
		// instant key-driven step.
		if msg.epoch != m.epoch {
			return m, nil
		}
		if m.gameOver || m.paused {
			return m, tickEvery(m.epoch, m.speed)
		}
		m.step()
		return m, tickEvery(m.epoch, m.speed)
	}
	return m, nil
}

// View renders the current frame.
func (m Model) View() string {
	field := m.renderField()
	if m.embedded {
		return field
	}

	header := theme.Title.Render("SNAKE — installed.exe edition")
	scoreLine := theme.Body.Render(fmt.Sprintf("score: %d   speed: %dms   grid: %d×%d",
		m.score, m.speed.Milliseconds(), m.GridW, m.GridH))
	hint := theme.Hint.Render("↑↓←→/wasd to move · p pause · r restart · q quit")

	return lipgloss.JoinVertical(
		lipgloss.Left,
		header,
		scoreLine,
		"",
		theme.Box.Render(field),
		"",
		hint,
	)
}

// renderField returns the playfield as a string of GridH rows × (2*GridW) cols.
func (m Model) renderField() string {
	grid := make([][]int, m.GridH)
	for y := range grid {
		grid[y] = make([]int, m.GridW)
	}
	for i, s := range m.snake {
		if s.X >= 0 && s.X < m.GridW && s.Y >= 0 && s.Y < m.GridH {
			if i == len(m.snake)-1 {
				grid[s.Y][s.X] = 2
			} else {
				grid[s.Y][s.X] = 1
			}
		}
	}
	if m.food.X >= 0 && m.food.X < m.GridW && m.food.Y >= 0 && m.food.Y < m.GridH {
		grid[m.food.Y][m.food.X] = 3
	}

	var rows []string
	body := lipgloss.NewStyle().Foreground(theme.NeonGreen)
	headStyle := lipgloss.NewStyle().Foreground(theme.NeonGreen).Bold(true).Reverse(true)
	foodStyle := theme.Food
	dotStyle := lipgloss.NewStyle().Foreground(theme.GreenDim)
	for _, row := range grid {
		var sb strings.Builder
		for _, v := range row {
			switch v {
			case 0:
				sb.WriteString(dotStyle.Render(" ·"))
			case 1:
				sb.WriteString(body.Render("██"))
			case 2:
				sb.WriteString(headStyle.Render("██"))
			case 3:
				sb.WriteString(foodStyle.Render("◆ "))
			}
		}
		rows = append(rows, sb.String())
	}

	field := strings.Join(rows, "\n")
	if m.gameOver {
		over := theme.Danger.Render("GAME OVER — press r to restart")
		field = field + "\n" + over
	} else if m.paused {
		paused := theme.Selected.Render("[ PAUSED — press p to resume ]")
		field = field + "\n" + paused
	}
	return field
}

// Score returns the current score.
func (m Model) Score() int { return m.score }

// IsOver reports whether the game has ended.
func (m Model) IsOver() bool { return m.gameOver }
