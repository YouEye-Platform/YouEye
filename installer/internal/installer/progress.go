package installer

import (
	"fmt"

	"github.com/charmbracelet/bubbles/progress"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/youeye-platform/YouEye/installer/internal/installer/theme"
)

func listenEngine(ch <-chan engineMsg) tea.Cmd {
	return func() tea.Msg {
		message, ok := <-ch
		if !ok {
			return engineMsg{Done: true}
		}
		return message
	}
}

type progressModel struct {
	width  int
	height int

	engineCh <-chan engineMsg
	stepName string
	percent  float64
	lastLog  string
	bar      progress.Model
	done     bool
	err      error
	config   installConfig
}

func newProgressModel(config installConfig) progressModel {
	bar := progress.New(progress.WithDefaultGradient(), progress.WithoutPercentage())
	bar.Width = 60
	return progressModel{config: config, stepName: "Starting installation...", bar: bar}
}

func (model progressModel) Init() tea.Cmd {
	if model.engineCh == nil {
		return nil
	}
	return listenEngine(model.engineCh)
}

func (model progressModel) Update(message tea.Msg) (progressModel, tea.Cmd) {
	switch message := message.(type) {
	case tea.WindowSizeMsg:
		model.width, model.height = message.Width, message.Height
		model.bar.Width = max(20, min(80, model.width-20))
		return model, nil
	case engineMsg:
		if message.Err != nil {
			model.err, model.done = message.Err, true
			return model, nil
		}
		if message.StepName != "" {
			model.stepName = message.StepName
		}
		if message.LogLine != "" {
			model.lastLog = message.LogLine
		}
		if message.Percent > model.percent {
			model.percent = message.Percent
		}
		if message.Done {
			model.done, model.percent, model.stepName = true, 1, "Installation complete"
			return model, model.bar.SetPercent(1)
		}
		return model, tea.Batch(listenEngine(model.engineCh), model.bar.SetPercent(model.percent))
	case progress.FrameMsg:
		updated, command := model.bar.Update(message)
		model.bar = updated.(progress.Model)
		return model, command
	}
	return model, nil
}

func (model progressModel) View() string {
	status := theme.Body.Render(model.stepName)
	if model.err != nil {
		status = theme.Danger.Render("ERROR: " + model.err.Error())
	} else if model.done {
		status = theme.Selected.Render("Complete: " + model.stepName)
	}
	detail := "No disk writes continue until all artifact, target, and confirmation checks pass."
	if model.lastLog != "" {
		detail = model.lastLog
	}
	hint := "Keep this window open until the current stage finishes."
	if model.done {
		hint = "Press Enter to continue."
	}
	content := lipgloss.JoinVertical(lipgloss.Left,
		theme.Title.Render("YouEye Installer"),
		"",
		status,
		"",
		model.bar.View(),
		theme.StatusBar.Render(fmt.Sprintf(" %3d%% ", int(model.percent*100))),
		"",
		theme.Dim.Render(detail),
		"",
		theme.Hint.Render(hint),
	)
	if model.width > 0 {
		return lipgloss.Place(model.width, model.height, lipgloss.Center, lipgloss.Center, content)
	}
	return content
}
