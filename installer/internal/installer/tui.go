package installer

import (
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"
)

// rootModel wraps the installer Model as a top-level Bubble Tea program.
type rootModel struct {
	installer Model
	width     int
	height    int
}

func newRootModel() rootModel {
	return rootModel{installer: New()}
}

func (m rootModel) Init() tea.Cmd {
	return m.installer.Init()
}

func (m rootModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		if msg.String() == "ctrl+c" {
			return m, tea.Quit
		}
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
	case QuitMsg:
		return m, tea.Quit
	}

	var cmd tea.Cmd
	m.installer, cmd = m.installer.Update(msg)
	return m, cmd
}

func (m rootModel) View() string {
	return m.installer.View()
}

// Run launches the interactive TUI installer. It takes over the terminal
// and returns when the user exits.
func Run() error {
	p := tea.NewProgram(
		newRootModel(),
		tea.WithAltScreen(),
		tea.WithMouseAllMotion(),
	)
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "installer error: %v\n", err)
		return err
	}
	return nil
}
