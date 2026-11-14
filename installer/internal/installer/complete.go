package installer

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/youeye-platform/YouEye/installer/internal/installer/theme"
)

type completeModel struct{ width, height int }

func newCompleteModel() completeModel     { return completeModel{} }
func (model completeModel) Init() tea.Cmd { return nil }
func (model completeModel) Update(message tea.Msg) (completeModel, tea.Cmd) {
	if size, ok := message.(tea.WindowSizeMsg); ok {
		model.width, model.height = size.Width, size.Height
	}
	return model, nil
}
func (model completeModel) View() string {
	rows := []string{
		"",
		theme.Title.Render("  YouEye installed"),
		"",
		theme.Body.Render("  System A is active. System B and Recovery are installed."),
		theme.Body.Render("  Written images and UEFI boot assets passed readback checks."),
		"",
		theme.Selected.Render("  Press Enter to turn the machine off."),
		theme.Selected.Render("  When it is off, remove the USB stick."),
		"",
		theme.Dim.Render("  First boot installs the exact platform release set."),
		theme.Dim.Render("  Web setup appears only after durable health checks pass."),
		theme.Dim.Render("  The owner and admins sign in on the console (Ctrl+Alt+F2)"),
		theme.Dim.Render("  with their YouEye ID password. Root is for emergencies and"),
		theme.Dim.Render("  stays locked unless you set a root password."),
		"",
		theme.Hint.Render("  Press Enter to turn off"),
		"",
	}
	boxed := theme.BoxAccent.Render(strings.Join(rows, "\n"))
	if model.width > 0 {
		return lipgloss.Place(model.width, model.height, lipgloss.Center, lipgloss.Center, boxed)
	}
	return boxed
}

type errorModel struct {
	width, height int
	err           error
}

func newErrorModel(err error) errorModel { return errorModel{err: err} }
func (model errorModel) Init() tea.Cmd   { return nil }
func (model errorModel) Update(message tea.Msg) (errorModel, tea.Cmd) {
	if size, ok := message.(tea.WindowSizeMsg); ok {
		model.width, model.height = size.Width, size.Height
	}
	return model, nil
}
func (model errorModel) View() string {
	rows := []string{
		"",
		theme.Danger.Render("  Installation failed"),
		"",
		theme.Danger.Render("  " + model.err.Error()),
		"",
		theme.Dim.Render("  No further disk mutations will be attempted."),
		"",
		theme.Hint.Render("  Press Enter to turn off"),
		"",
	}
	boxed := theme.Box.Render(strings.Join(rows, "\n"))
	if model.width > 0 {
		return lipgloss.Place(model.width, model.height, lipgloss.Center, lipgloss.Center, boxed)
	}
	return boxed
}

func wrapText(value string, width int) []string {
	if len(value) <= width {
		return []string{value}
	}
	var lines []string
	for len(value) > width {
		cut := width
		for cut > 0 && value[cut] != ' ' {
			cut--
		}
		if cut == 0 {
			cut = width
		}
		lines = append(lines, value[:cut])
		value = strings.TrimLeft(value[cut:], " ")
	}
	if value != "" {
		lines = append(lines, value)
	}
	return lines
}
