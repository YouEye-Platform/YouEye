package installer

import tea "github.com/charmbracelet/bubbletea"

type QuitMsg struct{}

type phase int

const (
	phaseInstallerWizard phase = iota
	phaseProgress
	phaseComplete
	phaseError
)

type Model struct {
	phase phase

	installer applianceWizardModel
	progress  progressModel
	complete  completeModel
	errModel  errorModel

	width  int
	height int
}

func NewWithOptions(opts CLIOptions) Model {
	return Model{
		phase:     phaseInstallerWizard,
		installer: newApplianceWizardModel(configFromOptions(opts), shellApplianceRunner{}),
	}
}

func (model Model) Init() tea.Cmd {
	return model.installer.Init()
}

func (model Model) Update(message tea.Msg) (Model, tea.Cmd) {
	if size, ok := message.(tea.WindowSizeMsg); ok {
		model.width, model.height = size.Width, size.Height
	}
	if key, ok := message.(tea.KeyMsg); ok {
		switch key.String() {
		case "q", "esc":
			if model.phase == phaseInstallerWizard && model.installer.atFirstStep() {
				return model, func() tea.Msg { return QuitMsg{} }
			}
			if model.phase == phaseComplete || model.phase == phaseError {
				return model, func() tea.Msg { return QuitMsg{} }
			}
		case "enter", " ":
			if model.phase == phaseComplete || model.phase == phaseError {
				return model, func() tea.Msg { return QuitMsg{} }
			}
		}
	}

	var command tea.Cmd
	switch model.phase {
	case phaseInstallerWizard:
		model.installer, command = model.installer.Update(message)
		if model.installer.done {
			model.progress = newProgressModel(model.installer.config)
			model.progress.width, model.progress.height = model.width, model.height
			model.progress.engineCh = startEngine(model.installer.config)
			model.phase = phaseProgress
			return model, model.progress.Init()
		}
	case phaseProgress:
		model.progress, command = model.progress.Update(message)
		if model.progress.done {
			if key, ok := message.(tea.KeyMsg); ok && (key.String() == "enter" || key.String() == " ") {
				if model.progress.err != nil {
					model.errModel = newErrorModel(model.progress.err)
					model.errModel.width, model.errModel.height = model.width, model.height
					model.phase = phaseError
					return model, nil
				}
				model.complete = newCompleteModel()
				model.complete.width, model.complete.height = model.width, model.height
				model.phase = phaseComplete
				return model, nil
			}
		}
	case phaseComplete:
		model.complete, command = model.complete.Update(message)
	case phaseError:
		model.errModel, command = model.errModel.Update(message)
	}
	return model, command
}

func (model Model) View() string {
	switch model.phase {
	case phaseInstallerWizard:
		return model.installer.View()
	case phaseProgress:
		return model.progress.View()
	case phaseComplete:
		return model.complete.View()
	case phaseError:
		return model.errModel.View()
	default:
		return ""
	}
}
