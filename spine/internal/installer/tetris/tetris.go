// Package tetris implements a classic tetromino-stacking game as a
// Bubble Tea sub-component. Standard 10×20 well, 7 piece types, hard drop
// with space, soft drop with ↓, rotate with ↑ / z. The drop interval
// decreases as the player clears lines, so difficulty ramps naturally.
//
// Like all the other games in this project, key input is processed
// immediately and a fresh tick is scheduled afterwards, so direction and
// rotation feel snappy with no per-frame lag.
package tetris

import (
	"fmt"
	"math/rand/v2"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/YouEye-Platform/YouEye/spine/internal/installer/theme"
)

// QuitMsg is sent when the user wants to return to the menu.
type QuitMsg struct{}

// gravityMsg is the periodic "drop one row" tick. The epoch field lets us
// invalidate stale ticks when the player force-drops or pauses.
type gravityMsg struct{ epoch int }

const (
	boardW = 10
	boardH = 20
)

// shape is a 4x4 sub-grid; cells are 1 if filled, 0 otherwise.
type shape [4][4]int

// pieceDef bundles a piece's four rotations and its color.
type pieceDef struct {
	rotations [4]shape
	color     lipgloss.Color
}

// Piece definitions. Shape data is the standard 4-rotation table — kept
// hard-coded for clarity; spelling these out by hand is faster to reason
// about than computing rotations at runtime.
var pieces = []pieceDef{
	// I — cyan
	{rotations: [4]shape{
		{{0, 0, 0, 0}, {1, 1, 1, 1}, {0, 0, 0, 0}, {0, 0, 0, 0}},
		{{0, 0, 1, 0}, {0, 0, 1, 0}, {0, 0, 1, 0}, {0, 0, 1, 0}},
		{{0, 0, 0, 0}, {0, 0, 0, 0}, {1, 1, 1, 1}, {0, 0, 0, 0}},
		{{0, 1, 0, 0}, {0, 1, 0, 0}, {0, 1, 0, 0}, {0, 1, 0, 0}},
	}, color: lipgloss.Color("#00ffff")},
	// O — yellow (rotation has no effect)
	{rotations: [4]shape{
		{{0, 1, 1, 0}, {0, 1, 1, 0}, {0, 0, 0, 0}, {0, 0, 0, 0}},
		{{0, 1, 1, 0}, {0, 1, 1, 0}, {0, 0, 0, 0}, {0, 0, 0, 0}},
		{{0, 1, 1, 0}, {0, 1, 1, 0}, {0, 0, 0, 0}, {0, 0, 0, 0}},
		{{0, 1, 1, 0}, {0, 1, 1, 0}, {0, 0, 0, 0}, {0, 0, 0, 0}},
	}, color: lipgloss.Color("#ffff00")},
	// T — purple
	{rotations: [4]shape{
		{{0, 1, 0, 0}, {1, 1, 1, 0}, {0, 0, 0, 0}, {0, 0, 0, 0}},
		{{0, 1, 0, 0}, {0, 1, 1, 0}, {0, 1, 0, 0}, {0, 0, 0, 0}},
		{{0, 0, 0, 0}, {1, 1, 1, 0}, {0, 1, 0, 0}, {0, 0, 0, 0}},
		{{0, 1, 0, 0}, {1, 1, 0, 0}, {0, 1, 0, 0}, {0, 0, 0, 0}},
	}, color: lipgloss.Color("#cc00ff")},
	// S — green
	{rotations: [4]shape{
		{{0, 1, 1, 0}, {1, 1, 0, 0}, {0, 0, 0, 0}, {0, 0, 0, 0}},
		{{0, 1, 0, 0}, {0, 1, 1, 0}, {0, 0, 1, 0}, {0, 0, 0, 0}},
		{{0, 1, 1, 0}, {1, 1, 0, 0}, {0, 0, 0, 0}, {0, 0, 0, 0}},
		{{0, 1, 0, 0}, {0, 1, 1, 0}, {0, 0, 1, 0}, {0, 0, 0, 0}},
	}, color: lipgloss.Color("#00ff00")},
	// Z — red
	{rotations: [4]shape{
		{{1, 1, 0, 0}, {0, 1, 1, 0}, {0, 0, 0, 0}, {0, 0, 0, 0}},
		{{0, 0, 1, 0}, {0, 1, 1, 0}, {0, 1, 0, 0}, {0, 0, 0, 0}},
		{{1, 1, 0, 0}, {0, 1, 1, 0}, {0, 0, 0, 0}, {0, 0, 0, 0}},
		{{0, 0, 1, 0}, {0, 1, 1, 0}, {0, 1, 0, 0}, {0, 0, 0, 0}},
	}, color: lipgloss.Color("#ff3030")},
	// J — blue
	{rotations: [4]shape{
		{{1, 0, 0, 0}, {1, 1, 1, 0}, {0, 0, 0, 0}, {0, 0, 0, 0}},
		{{0, 1, 1, 0}, {0, 1, 0, 0}, {0, 1, 0, 0}, {0, 0, 0, 0}},
		{{0, 0, 0, 0}, {1, 1, 1, 0}, {0, 0, 1, 0}, {0, 0, 0, 0}},
		{{0, 1, 0, 0}, {0, 1, 0, 0}, {1, 1, 0, 0}, {0, 0, 0, 0}},
	}, color: lipgloss.Color("#3060ff")},
	// L — orange
	{rotations: [4]shape{
		{{0, 0, 1, 0}, {1, 1, 1, 0}, {0, 0, 0, 0}, {0, 0, 0, 0}},
		{{0, 1, 0, 0}, {0, 1, 0, 0}, {0, 1, 1, 0}, {0, 0, 0, 0}},
		{{0, 0, 0, 0}, {1, 1, 1, 0}, {1, 0, 0, 0}, {0, 0, 0, 0}},
		{{1, 1, 0, 0}, {0, 1, 0, 0}, {0, 1, 0, 0}, {0, 0, 0, 0}},
	}, color: lipgloss.Color("#ff9000")},
}

// Active piece in flight.
type active struct {
	idx      int // index into pieces
	x, y     int // top-left of the 4x4 bounding box on the board
	rotation int
}

// Model holds Tetris game state.
type Model struct {
	// board[y][x] = -1 (empty) or piece index for color.
	board [boardH][boardW]int

	cur    active
	next   int // index of the next piece (preview)
	score  int
	lines  int
	level  int
	dropMs int

	gameOver bool
	paused   bool

	epoch int
	rng   *rand.Rand
}

// New constructs a Tetris model.
func New() Model {
	m := Model{
		dropMs: 900,
		rng:    rand.New(rand.NewPCG(uint64(time.Now().UnixNano()), 0xC0FFEE)),
	}
	for y := 0; y < boardH; y++ {
		for x := 0; x < boardW; x++ {
			m.board[y][x] = -1
		}
	}
	m.next = m.rng.IntN(len(pieces))
	m.spawn()
	return m
}

// Init schedules the first gravity tick.
func (m Model) Init() tea.Cmd { return m.gravityCmd() }

func (m Model) gravityCmd() tea.Cmd {
	return tea.Tick(time.Duration(m.dropMs)*time.Millisecond, func(t time.Time) tea.Msg {
		_ = t
		return gravityMsg{epoch: m.epoch}
	})
}

// spawn brings a new piece into play. Sets gameOver if it doesn't fit.
func (m *Model) spawn() {
	m.cur = active{
		idx:      m.next,
		x:        boardW/2 - 2,
		y:        0,
		rotation: 0,
	}
	m.next = m.rng.IntN(len(pieces))
	if m.collides(m.cur) {
		m.gameOver = true
	}
}

// collides reports whether the given active piece overlaps a wall, the
// floor, or a settled block.
func (m *Model) collides(a active) bool {
	s := pieces[a.idx].rotations[a.rotation]
	for dy := 0; dy < 4; dy++ {
		for dx := 0; dx < 4; dx++ {
			if s[dy][dx] == 0 {
				continue
			}
			x, y := a.x+dx, a.y+dy
			if x < 0 || x >= boardW || y >= boardH {
				return true
			}
			if y < 0 {
				continue // above the board is fine while spawning
			}
			if m.board[y][x] >= 0 {
				return true
			}
		}
	}
	return false
}

// lock writes the current piece into the board, clears completed lines,
// updates score/level, and spawns the next piece.
func (m *Model) lock() {
	a := m.cur
	s := pieces[a.idx].rotations[a.rotation]
	for dy := 0; dy < 4; dy++ {
		for dx := 0; dx < 4; dx++ {
			if s[dy][dx] == 0 {
				continue
			}
			x, y := a.x+dx, a.y+dy
			if y >= 0 && y < boardH && x >= 0 && x < boardW {
				m.board[y][x] = a.idx
			}
		}
	}
	m.clearLines()
	m.spawn()
}

// clearLines removes filled rows and shifts everything above down.
// Score follows the original NES table: 40/100/300/1200 × (level+1).
func (m *Model) clearLines() {
	cleared := 0
	for y := boardH - 1; y >= 0; y-- {
		full := true
		for x := 0; x < boardW; x++ {
			if m.board[y][x] < 0 {
				full = false
				break
			}
		}
		if full {
			cleared++
			// Shift rows above y down by one.
			for yy := y; yy > 0; yy-- {
				m.board[yy] = m.board[yy-1]
			}
			for x := 0; x < boardW; x++ {
				m.board[0][x] = -1
			}
			y++ // re-check this row index
		}
	}
	if cleared > 0 {
		m.lines += cleared
		multipliers := []int{0, 40, 100, 300, 1200}
		m.score += multipliers[cleared] * (m.level + 1)
		newLevel := m.lines / 10
		if newLevel > m.level {
			m.level = newLevel
			m.dropMs = 900 - newLevel*70
			if m.dropMs < 80 {
				m.dropMs = 80
			}
		}
	}
}

// tryMove applies a delta to the piece position, undoing if it collides.
// Returns true on success.
func (m *Model) tryMove(dx, dy int) bool {
	tentative := m.cur
	tentative.x += dx
	tentative.y += dy
	if m.collides(tentative) {
		return false
	}
	m.cur = tentative
	return true
}

// tryRotate rotates the piece by `delta` (+1 CW, -1 CCW). Includes a
// minimal wall-kick so rotations near walls feel natural.
func (m *Model) tryRotate(delta int) {
	tentative := m.cur
	tentative.rotation = (tentative.rotation + delta + 4) % 4
	for _, kick := range []int{0, -1, 1, -2, 2} {
		t2 := tentative
		t2.x += kick
		if !m.collides(t2) {
			m.cur = t2
			return
		}
	}
}

// hardDrop slams the piece to the bottom and locks it. Awards 2 pts/cell
// to reward decisive play.
func (m *Model) hardDrop() {
	dist := 0
	for m.tryMove(0, 1) {
		dist++
	}
	m.score += dist * 2
	m.lock()
}

// Update handles one frame.
func (m Model) Update(msg tea.Msg) (Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		if m.gameOver {
			if msg.String() == "r" {
				return New(), New().Init()
			}
			if msg.String() == "q" || msg.String() == "esc" {
				return m, func() tea.Msg { return QuitMsg{} }
			}
			return m, nil
		}
		switch msg.String() {
		case "left", "a":
			m.tryMove(-1, 0)
		case "right", "d":
			m.tryMove(1, 0)
		case "down", "s":
			if !m.tryMove(0, 1) {
				m.lock()
			}
			m.score++ // soft-drop bonus
		case " ", "space":
			m.hardDrop()
		case "up", "x":
			m.tryRotate(1)
		case "z":
			m.tryRotate(-1)
		case "p":
			m.paused = !m.paused
			if !m.paused {
				m.epoch++
				return m, m.gravityCmd()
			}
		case "r":
			return New(), New().Init()
		case "q", "esc":
			return m, func() tea.Msg { return QuitMsg{} }
		}
		return m, nil

	case gravityMsg:
		if msg.epoch != m.epoch {
			return m, nil
		}
		if m.paused || m.gameOver {
			return m, m.gravityCmd()
		}
		if !m.tryMove(0, 1) {
			m.lock()
		}
		return m, m.gravityCmd()
	}
	return m, nil
}

// View renders the playfield + side panel.
func (m Model) View() string {
	field := m.renderBoard()
	side := m.renderSide()

	main := lipgloss.JoinHorizontal(lipgloss.Top, theme.Box.Render(field), "  ", theme.Box.Render(side))

	header := theme.Title.Render("TETRIS — block falling simulator")
	hint := theme.Hint.Render("←→ move · ↓ soft drop · space hard drop · ↑/x rotate · z rotate ccw · p pause · r restart · q quit")

	return lipgloss.JoinVertical(lipgloss.Left, header, "", main, "", hint)
}

// renderBoard draws the well, current piece, and ghost/overlay messages.
func (m Model) renderBoard() string {
	// Composite: copy board, overlay current piece for rendering.
	var view [boardH][boardW]int
	for y := 0; y < boardH; y++ {
		for x := 0; x < boardW; x++ {
			view[y][x] = m.board[y][x]
		}
	}
	if !m.gameOver {
		s := pieces[m.cur.idx].rotations[m.cur.rotation]
		for dy := 0; dy < 4; dy++ {
			for dx := 0; dx < 4; dx++ {
				if s[dy][dx] == 0 {
					continue
				}
				x, y := m.cur.x+dx, m.cur.y+dy
				if y >= 0 && y < boardH && x >= 0 && x < boardW {
					view[y][x] = m.cur.idx
				}
			}
		}
	}

	emptyStyle := lipgloss.NewStyle().Foreground(theme.AmberDim)
	var rows []string
	for y := 0; y < boardH; y++ {
		var sb strings.Builder
		for x := 0; x < boardW; x++ {
			v := view[y][x]
			if v < 0 {
				sb.WriteString(emptyStyle.Render(" ·"))
			} else {
				sb.WriteString(lipgloss.NewStyle().Foreground(pieces[v].color).Bold(true).Render("██"))
			}
		}
		rows = append(rows, sb.String())
	}
	out := strings.Join(rows, "\n")
	if m.paused {
		out += "\n" + theme.Selected.Render("[ PAUSED — press p to resume ]")
	} else if m.gameOver {
		out += "\n" + theme.Danger.Render("GAME OVER — r to restart, q to quit")
	}
	return out
}

// renderSide draws score / level / lines / next-piece preview.
func (m Model) renderSide() string {
	scoreLine := theme.Body.Render(fmt.Sprintf("score: %d", m.score))
	lvlLine := theme.Body.Render(fmt.Sprintf("level: %d", m.level))
	linesLine := theme.Body.Render(fmt.Sprintf("lines: %d", m.lines))
	speedLine := theme.Dim.Render(fmt.Sprintf("drop:  %dms", m.dropMs))

	// Render next piece in a 4x4 mini-grid.
	preview := pieces[m.next].rotations[0]
	color := pieces[m.next].color
	var pr []string
	for y := 0; y < 4; y++ {
		var sb strings.Builder
		for x := 0; x < 4; x++ {
			if preview[y][x] == 1 {
				sb.WriteString(lipgloss.NewStyle().Foreground(color).Bold(true).Render("██"))
			} else {
				sb.WriteString("  ")
			}
		}
		pr = append(pr, sb.String())
	}
	previewBlock := strings.Join(pr, "\n")

	return lipgloss.JoinVertical(lipgloss.Left,
		theme.Title.Render("STATS"),
		"",
		scoreLine,
		lvlLine,
		linesLine,
		speedLine,
		"",
		theme.Title.Render("NEXT"),
		previewBlock,
	)
}
