// Package twofortyeight implements the classic 4×4 tile-merging puzzle
// game. Arrow keys (or WASD) slide every tile in that direction; when two
// tiles of the same value collide they merge into one with double the
// value, and a new 2 (sometimes 4) tile spawns on a random empty cell.
// You win at 2048 and lose when no moves are possible.
package twofortyeight

import (
	"fmt"
	"math/rand/v2"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/YouEye-Platform/YouEye/spine/internal/installer/theme"
)

// QuitMsg returns to the menu.
type QuitMsg struct{}

const size = 4

// Model holds 2048 game state.
type Model struct {
	grid     [size][size]int
	score    int
	best     int
	won      bool
	gameOver bool
	rng      *rand.Rand
}

// New constructs a fresh game.
func New() Model {
	m := Model{
		rng: rand.New(rand.NewPCG(uint64(time.Now().UnixNano()), 0xBEEF1)),
	}
	m.spawn()
	m.spawn()
	return m
}

// Init is a no-op; this game is purely event-driven.
func (m Model) Init() tea.Cmd { return nil }

// Best returns the high-water score so the parent can preserve it across
// game restarts.
func (m Model) Best() int { return m.best }

// SetBest restores a previously-stored best score.
func (m *Model) SetBest(b int) { m.best = b }

// spawn places a 2 (90% chance) or 4 (10%) on a random empty cell.
func (m *Model) spawn() bool {
	type pos struct{ x, y int }
	var empty []pos
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			if m.grid[y][x] == 0 {
				empty = append(empty, pos{x, y})
			}
		}
	}
	if len(empty) == 0 {
		return false
	}
	p := empty[m.rng.IntN(len(empty))]
	val := 2
	if m.rng.Float64() < 0.1 {
		val = 4
	}
	m.grid[p.y][p.x] = val
	return true
}

// slideRow squashes one row leftward. Returns the new row + score added by
// merges. This is the canonical 1-D slide; all 4 directions reuse it via
// reflection / rotation.
func slideRow(row [size]int) ([size]int, int) {
	// 1. Compact non-zero values to the left.
	var compact [size]int
	idx := 0
	for _, v := range row {
		if v != 0 {
			compact[idx] = v
			idx++
		}
	}
	// 2. Merge adjacent equal pairs (leftmost first).
	score := 0
	for i := 0; i < size-1; i++ {
		if compact[i] != 0 && compact[i] == compact[i+1] {
			compact[i] *= 2
			compact[i+1] = 0
			score += compact[i]
		}
	}
	// 3. Compact again after merges.
	var out [size]int
	idx = 0
	for _, v := range compact {
		if v != 0 {
			out[idx] = v
			idx++
		}
	}
	return out, score
}

// reverseRow flips a row in place.
func reverseRow(row [size]int) [size]int {
	for i, j := 0, size-1; i < j; i, j = i+1, j-1 {
		row[i], row[j] = row[j], row[i]
	}
	return row
}

// move slides the entire grid in `dir` (0=left, 1=right, 2=up, 3=down).
// Returns true if anything actually moved.
func (m *Model) move(dir int) bool {
	before := m.grid
	switch dir {
	case 0: // left
		for y := 0; y < size; y++ {
			out, sc := slideRow(m.grid[y])
			m.grid[y] = out
			m.score += sc
		}
	case 1: // right
		for y := 0; y < size; y++ {
			rev := reverseRow(m.grid[y])
			out, sc := slideRow(rev)
			m.grid[y] = reverseRow(out)
			m.score += sc
		}
	case 2: // up — rotate to left, slide, rotate back
		for x := 0; x < size; x++ {
			var col [size]int
			for y := 0; y < size; y++ {
				col[y] = m.grid[y][x]
			}
			out, sc := slideRow(col)
			for y := 0; y < size; y++ {
				m.grid[y][x] = out[y]
			}
			m.score += sc
		}
	case 3: // down
		for x := 0; x < size; x++ {
			var col [size]int
			for y := 0; y < size; y++ {
				col[y] = m.grid[y][x]
			}
			rev := reverseRow(col)
			out, sc := slideRow(rev)
			out = reverseRow(out)
			for y := 0; y < size; y++ {
				m.grid[y][x] = out[y]
			}
			m.score += sc
		}
	}
	if m.score > m.best {
		m.best = m.score
	}
	return m.grid != before
}

// canMove reports whether any move is currently possible.
func (m *Model) canMove() bool {
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			if m.grid[y][x] == 0 {
				return true
			}
			if x+1 < size && m.grid[y][x] == m.grid[y][x+1] {
				return true
			}
			if y+1 < size && m.grid[y][x] == m.grid[y+1][x] {
				return true
			}
		}
	}
	return false
}

// hasWon checks for a 2048 tile.
func (m *Model) hasWon() bool {
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			if m.grid[y][x] >= 2048 {
				return true
			}
		}
	}
	return false
}

// Update handles input.
func (m Model) Update(msg tea.Msg) (Model, tea.Cmd) {
	if k, ok := msg.(tea.KeyMsg); ok {
		switch k.String() {
		case "q", "esc":
			return m, func() tea.Msg { return QuitMsg{} }
		case "r":
			best := m.best
			m = New()
			m.best = best
			return m, nil
		}
		if m.gameOver {
			return m, nil
		}

		var dir = -1
		switch k.String() {
		case "left", "a":
			dir = 0
		case "right", "d":
			dir = 1
		case "up", "w":
			dir = 2
		case "down", "s":
			dir = 3
		}
		if dir >= 0 {
			if m.move(dir) {
				m.spawn()
				if !m.won && m.hasWon() {
					m.won = true
				}
				if !m.canMove() {
					m.gameOver = true
				}
			}
		}
	}
	return m, nil
}

// tileColor returns the (foreground, background) styling for a given tile
// value. Higher values get hotter colors; mirrors the original web game.
func tileColor(v int) (lipgloss.Color, lipgloss.Color) {
	switch v {
	case 0:
		return lipgloss.Color("#3a3a3a"), lipgloss.Color("#1a1a1a")
	case 2:
		return lipgloss.Color("#3a3a3a"), lipgloss.Color("#eee4da")
	case 4:
		return lipgloss.Color("#3a3a3a"), lipgloss.Color("#ede0c8")
	case 8:
		return lipgloss.Color("#ffffff"), lipgloss.Color("#f2b179")
	case 16:
		return lipgloss.Color("#ffffff"), lipgloss.Color("#f59563")
	case 32:
		return lipgloss.Color("#ffffff"), lipgloss.Color("#f67c5f")
	case 64:
		return lipgloss.Color("#ffffff"), lipgloss.Color("#f65e3b")
	case 128:
		return lipgloss.Color("#ffffff"), lipgloss.Color("#edcf72")
	case 256:
		return lipgloss.Color("#ffffff"), lipgloss.Color("#edcc61")
	case 512:
		return lipgloss.Color("#ffffff"), lipgloss.Color("#edc850")
	case 1024:
		return lipgloss.Color("#ffffff"), lipgloss.Color("#edc53f")
	default: // 2048+
		return lipgloss.Color("#ffffff"), lipgloss.Color("#edc22e")
	}
}

// View renders the grid + score.
func (m Model) View() string {
	header := theme.Title.Render("2048 — slide and merge")
	scoreLine := lipgloss.NewStyle().Foreground(theme.Amber).Bold(true).Render(
		fmt.Sprintf("score: %d   best: %d", m.score, m.best))

	const cellW = 7
	tileStyle := func(v int) lipgloss.Style {
		fg, bg := tileColor(v)
		return lipgloss.NewStyle().
			Foreground(fg).
			Background(bg).
			Bold(true).
			Width(cellW).
			Align(lipgloss.Center)
	}

	var rows []string
	for y := 0; y < size; y++ {
		var top, mid, bot []string
		for x := 0; x < size; x++ {
			v := m.grid[y][x]
			label := ""
			if v != 0 {
				label = fmt.Sprintf("%d", v)
			}
			top = append(top, tileStyle(v).Render(strings.Repeat(" ", cellW)))
			mid = append(mid, tileStyle(v).Render(label))
			bot = append(bot, tileStyle(v).Render(strings.Repeat(" ", cellW)))
		}
		rows = append(rows,
			strings.Join(top, " "),
			strings.Join(mid, " "),
			strings.Join(bot, " "),
		)
		rows = append(rows, "") // gap between tile rows
	}
	board := strings.Join(rows, "\n")

	hint := theme.Hint.Render("↑↓←→/wasd · r restart · q quit")
	if m.gameOver {
		hint = theme.Danger.Render("GAME OVER — no moves left. r to restart, q to quit.")
	} else if m.won {
		hint = theme.Selected.Render(" YOU REACHED 2048 — keep going or press r/q ")
	}

	return lipgloss.JoinVertical(lipgloss.Left,
		header,
		scoreLine,
		"",
		board,
		hint,
	)
}
