// Package installer implements the full YouEye install experience:
//
//	detect → wizard (Proxmox) or direct install (bare OS) → progress → complete / error
//
// On Proxmox: detect → "not ready yet" message (Proxmox helper script not ready)
// On bare Linux: detect → progress (skip wizard, auto-start install with games) → complete / error
package installer

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/YouEye-Platform/YouEye/spine/internal/installer/theme"
)

// QuitMsg is emitted to return to the main menu / exit.
type QuitMsg struct{}

// phase tracks where we are in the install flow.
type phase int

const (
	phaseDetect          phase = iota
	phaseProxmoxNotReady       // Proxmox detected but helper script not ready
	phaseWizard                // Proxmox only: mode, path, steps, confirm
	phaseProgress              // real install + games
	phaseComplete              // success summary
	phaseError                 // failure details
)

// Model is the top-level installer model.
type Model struct {
	phase phase

	detect   detectModel
	wizard   wizardModel
	progress progressModel
	complete completeModel
	errModel errorModel

	width, height int
}

// New constructs a fresh installer.
func New() Model {
	return Model{
		phase:  phaseDetect,
		detect: newDetectModel(),
	}
}

// Init kicks off the detect animation + real detection.
func (m Model) Init() tea.Cmd {
	return m.detect.Init()
}

// Update routes messages through the active phase.
func (m Model) Update(msg tea.Msg) (Model, tea.Cmd) {
	// Broadcast window size to all phases.
	if ws, ok := msg.(tea.WindowSizeMsg); ok {
		m.width, m.height = ws.Width, ws.Height
	}

	// Global quit.
	if km, ok := msg.(tea.KeyMsg); ok {
		switch km.String() {
		case "q", "esc":
			switch m.phase {
			case phaseProxmoxNotReady:
				return m, func() tea.Msg { return QuitMsg{} }
			case phaseProgress:
				if m.progress.ready {
					// Not yet installing — safe to go back
					return m, func() tea.Msg { return QuitMsg{} }
				}
				// During installation, q/esc does nothing (can't cancel mid-install)
				return m, nil
			case phaseComplete, phaseError:
				return m, func() tea.Msg { return QuitMsg{} }
			case phaseDetect:
				if m.detect.done && m.detect.env.IsContainer {
					return m, func() tea.Msg { return QuitMsg{} }
				}
				if m.detect.done && m.detect.err != nil {
					return m, func() tea.Msg { return QuitMsg{} }
				}
				if m.detect.scanning {
					return m, func() tea.Msg { return QuitMsg{} }
				}
			case phaseWizard:
				if km.String() == "esc" && m.wizard.current == 0 {
					return m, func() tea.Msg { return QuitMsg{} }
				}
			}

		case "enter", " ":
			switch m.phase {
			case phaseProxmoxNotReady:
				return m, func() tea.Msg { return QuitMsg{} }
			case phaseComplete:
				return m, func() tea.Msg { return QuitMsg{} }
			case phaseError:
				return m, func() tea.Msg { return QuitMsg{} }
			}
		}
	}

	var cmd tea.Cmd

	switch m.phase {
	case phaseDetect:
		m.detect, cmd = m.detect.Update(msg)
		if m.detect.done {
			// If running inside a container, stay on detect screen (shows error)
			if m.detect.env.IsContainer {
				return m, cmd
			}
			if m.detect.err != nil {
				return m, cmd
			}

			// Proxmox detected: show "not ready yet" message
			if m.detect.env.IsProxmox {
				m.phase = phaseProxmoxNotReady
				return m, nil
			}

			// Bare OS (not Proxmox): skip wizard entirely, go straight to install.
			// Start the engine HERE on the real model — Init() is a value receiver
			// so it cannot set engineCh (changes would be lost on the copy).
			cfg := newConfigFromEnv(m.detect.env)
			cfg.Mode = modeHost
			m.progress = newProgressModel(cfg)
			m.progress.autoStart = true
			m.progress.ready = false
			m.progress.engineCh = startEngine(cfg)
			m.progress.width, m.progress.height = m.width, m.height
			m.phase = phaseProgress
			return m, m.progress.Init()
		}
		return m, cmd

	case phaseProxmoxNotReady:
		// Static screen — no updates needed
		return m, nil

	case phaseWizard:
		m.wizard, cmd = m.wizard.Update(msg)
		if m.wizard.done {
			m.progress = newProgressModel(m.wizard.config)
			m.progress.width, m.progress.height = m.width, m.height
			m.phase = phaseProgress
			return m, m.progress.Init()
		}
		return m, cmd

	case phaseProgress:
		m.progress, cmd = m.progress.Update(msg)
		if m.progress.done {
			if km, ok := msg.(tea.KeyMsg); ok && (km.String() == "enter" || km.String() == " ") {
				if m.progress.err != nil {
					cfg := m.progress.config
					m.errModel = newErrorModel(cfg, m.progress.err)
					m.errModel.width, m.errModel.height = m.width, m.height
					m.phase = phaseError
					return m, m.errModel.Init()
				}
				cfg := m.progress.config
				cfg.ResultIP = m.progress.resultIP
				m.complete = newCompleteModel(cfg)
				m.complete.width, m.complete.height = m.width, m.height
				m.phase = phaseComplete
				return m, m.complete.Init()
			}
		}
		return m, cmd

	case phaseComplete:
		m.complete, cmd = m.complete.Update(msg)
		return m, cmd

	case phaseError:
		m.errModel, cmd = m.errModel.Update(msg)
		return m, cmd
	}

	return m, nil
}

// View dispatches to the active phase.
func (m Model) View() string {
	switch m.phase {
	case phaseDetect:
		return m.detect.View()
	case phaseProxmoxNotReady:
		return m.viewProxmoxNotReady()
	case phaseWizard:
		return m.wizard.View()
	case phaseProgress:
		return m.progress.View()
	case phaseComplete:
		return m.complete.View()
	case phaseError:
		return m.errModel.View()
	}
	return ""
}

// viewProxmoxNotReady renders a message telling the user the Proxmox
// helper script is not ready yet.
func (m Model) viewProxmoxNotReady() string {
	var rows []string
	rows = append(rows,
		"",
		theme.Title.Render("  Proxmox VE Detected"),
		"",
	)

	if m.detect.env.PVEVersion != "" {
		rows = append(rows, theme.Body.Render("  Version: "+m.detect.env.PVEVersion))
		rows = append(rows, "")
	}

	rows = append(rows,
		theme.Body.Render("  The Proxmox helper script is not ready yet."),
		"",
		theme.Dim.Render("  The Proxmox installer (LXC/VM creation, wizard,"),
		theme.Dim.Render("  and automated provisioning) is under development."),
		"",
		theme.Dim.Render("  For now, you can install YouEye on bare Linux:"),
		"",
		theme.Body.Render("    1. Create a Debian 13 LXC/VM manually"),
		theme.Body.Render("    2. Run this installer inside it"),
		"",
	)

	divider := theme.Dim.Render(strings.Repeat("─", 50))
	rows = append(rows, divider)
	rows = append(rows, theme.Hint.Render("  Press any key to exit"))
	rows = append(rows, "")

	body := strings.Join(rows, "\n")
	boxed := theme.BoxAccent.Render(body)

	if m.width > 0 {
		return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, boxed)
	}
	return boxed
}
