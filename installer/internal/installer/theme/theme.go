// Package theme defines the retro-CRT visual identity of the YouEye installer.
//
// Palette is intentionally narrow: amber primary (phosphor-style), deep black
// background, magenta for accents/selections, neon green for the Snake mini-game,
// and red for danger / errors. Everything is built from these.
package theme

import "github.com/charmbracelet/lipgloss"

// Core palette.
var (
	Amber      = lipgloss.Color("#ffb000") // primary phosphor amber
	AmberDim   = lipgloss.Color("#8a5e00") // dimmed amber for secondary text
	AmberBoot  = lipgloss.Color("#ff8c00") // hotter amber for boot effects
	Magenta    = lipgloss.Color("#ff00ff") // accent / selection
	MagentaDim = lipgloss.Color("#a0007a")
	NeonGreen  = lipgloss.Color("#00ff41") // snake matrix-green
	GreenDim   = lipgloss.Color("#005a17")
	Red        = lipgloss.Color("#ff3b3b")
	White      = lipgloss.Color("#f4f4f4")
	Bg         = lipgloss.Color("#0a0a0a")
)

// Reusable styles.
var (
	Title = lipgloss.NewStyle().
		Foreground(Amber).
		Bold(true)

	Subtitle = lipgloss.NewStyle().
			Foreground(AmberDim).
			Italic(true)

	Body = lipgloss.NewStyle().
		Foreground(Amber)

	Dim = lipgloss.NewStyle().
		Foreground(AmberDim)

	Selected = lipgloss.NewStyle().
			Foreground(Magenta).
			Bold(true)

	Box = lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(Amber).
		Padding(0, 1)

	BoxAccent = lipgloss.NewStyle().
			Border(lipgloss.DoubleBorder()).
			BorderForeground(Magenta).
			Padding(0, 1)

	StatusBar = lipgloss.NewStyle().
			Foreground(Bg).
			Background(Amber).
			Padding(0, 1).
			Bold(true)

	Hint = lipgloss.NewStyle().
		Foreground(AmberDim).
		Italic(true)

	Snake = lipgloss.NewStyle().
		Foreground(NeonGreen).
		Bold(true)

	Food = lipgloss.NewStyle().
		Foreground(Red).
		Bold(true)

	Danger = lipgloss.NewStyle().
		Foreground(Red).
		Bold(true)
)
