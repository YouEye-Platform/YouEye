package installer

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/charmbracelet/bubbles/progress"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/youeye-platform/YouEye/installer/internal/installer/tetris"
	"github.com/youeye-platform/YouEye/installer/internal/installer/theme"
)

type proxmoxTUIPhase int

const (
	proxmoxPhaseLoading proxmoxTUIPhase = iota
	proxmoxPhaseChoice
	proxmoxPhaseAdvanced
	proxmoxPhaseReviewLoading
	proxmoxPhaseReview
	proxmoxPhaseProgress
	proxmoxPhaseDone
	proxmoxPhaseError
)

type proxmoxInventoryMsg struct {
	Inventory proxmoxApplianceInventory
	Err       error
}

type proxmoxExistingMsg struct {
	Existing compatibleProxmoxApplianceVM
	Err      error
}

type proxmoxProgressMsg struct {
	Progress proxmoxApplianceProgress
	Open     bool
}

type proxmoxFormField struct {
	Label    string
	Kind     string
	InputKey string
	Page     int
}

var proxmoxAdvancedFields = []proxmoxFormField{
	{Label: "Operation", Kind: "operation", Page: 0},
	{Label: "VMID", Kind: "input", InputKey: "vmid", Page: 0},
	{Label: "Name", Kind: "input", InputKey: "name", Page: 0},
	{Label: "Continue", Kind: "continue", Page: 0},
	{Label: "CPU cores", Kind: "input", InputKey: "cpu", Page: 1},
	{Label: "Memory MiB", Kind: "input", InputKey: "ram", Page: 1},
	{Label: "Drive size GiB", Kind: "input", InputKey: "target-size", Page: 1},
	{Label: "Continue", Kind: "continue", Page: 1},
	{Label: "Drive storage", Kind: "target-storage", Page: 2},
	{Label: "ISO storage", Kind: "iso-storage", Page: 2},
	{Label: "Bridge", Kind: "bridge", Page: 2},
	{Label: "Network", Kind: "network", Page: 2},
	{Label: "IPv4 CIDR", Kind: "input", InputKey: "address", Page: 2},
	{Label: "Gateway", Kind: "input", InputKey: "gateway", Page: 2},
	{Label: "DNS", Kind: "input", InputKey: "dns", Page: 2},
	{Label: "Continue", Kind: "continue", Page: 2},
	{Label: "Release source", Kind: "release-provider", Page: 3},
	{Label: "Releases API", Kind: "input", InputKey: "releases-api", Page: 3},
	{Label: "Release track", Kind: "channel", Page: 3},
	{Label: "Branch", Kind: "input", InputKey: "branch", Page: 3},
	{Label: "Freshness", Kind: "freshness", Page: 3},
	{Label: "Exact tag", Kind: "input", InputKey: "tag", Page: 3},
	{Label: "ISO SHA-256", Kind: "input", InputKey: "digest", Page: 3},
	{Label: "Continue", Kind: "continue", Page: 3},
	{Label: "Host SSH keys", Kind: "ssh-toggle", Page: 4},
	{Label: "Extra SSH keys", Kind: "input", InputKey: "keys", Page: 4},
	{Label: "Continue", Kind: "continue", Page: 4},
	{Label: "Root console", Kind: "development-local", Page: 5},
	{Label: "Root password SSH", Kind: "development-ssh", Page: 5},
	{Label: "Root password", Kind: "input", InputKey: "root-password", Page: 5},
	{Label: "Confirm password", Kind: "input", InputKey: "root-password-confirm", Page: 5},
	{Label: "Continue", Kind: "continue", Page: 5},
}

type proxmoxApplianceModel struct {
	opts      CLIOptions
	phase     proxmoxTUIPhase
	inventory proxmoxApplianceInventory
	config    proxmoxApplianceConfig
	existing  compatibleProxmoxApplianceVM

	choice         int
	cursor         int
	page           int
	quick          bool
	eraseChoice    int
	inputs         map[string]textinput.Model
	releaseAPIs    map[string]string
	developmentSSH bool
	keyPreflight   sshKeyImportResult

	progressCh <-chan proxmoxApplianceProgress
	bar        progress.Model
	game       tetris.Model
	stage      string
	detail     string
	percent    float64
	resultURL  string
	err        error
	width      int
	height     int
}

func newProxmoxApplianceModel(opts CLIOptions) proxmoxApplianceModel {
	bar := progress.New(progress.WithDefaultGradient(), progress.WithoutPercentage())
	bar.Width = 60
	return proxmoxApplianceModel{
		opts: opts, phase: proxmoxPhaseLoading, inputs: make(map[string]textinput.Model), releaseAPIs: make(map[string]string),
		bar: bar, game: tetris.New(), stage: "Inspecting Proxmox host",
	}
}

func (m proxmoxApplianceModel) Init() tea.Cmd {
	return func() tea.Msg {
		inventory, err := discoverProxmoxApplianceInventory(execProxmoxCommandRunner{})
		return proxmoxInventoryMsg{Inventory: inventory, Err: err}
	}
}

func (m proxmoxApplianceModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if size, ok := msg.(tea.WindowSizeMsg); ok {
		m.width, m.height = size.Width, size.Height
		m.bar.Width = size.Width - 18
		if m.bar.Width < 24 {
			m.bar.Width = 24
		}
		if m.bar.Width > 72 {
			m.bar.Width = 72
		}
		m.resizeAdvancedInputs()
	}
	if key, ok := msg.(tea.KeyMsg); ok && key.String() == "ctrl+c" {
		return m, tea.Quit
	}

	switch m.phase {
	case proxmoxPhaseLoading:
		if result, ok := msg.(proxmoxInventoryMsg); ok {
			if result.Err != nil {
				m.err = result.Err
				m.phase = proxmoxPhaseError
				return m, nil
			}
			m.inventory = result.Inventory
			m.config = proxmoxApplianceConfigFromOptions(m.opts, m.inventory)
			m.initAdvancedInputs()
			m.phase = proxmoxPhaseChoice
		}
		return m, nil

	case proxmoxPhaseChoice:
		if key, ok := msg.(tea.KeyMsg); ok {
			switch key.String() {
			case "up", "k", "down", "j":
				m.choice = 1 - m.choice
			case "enter":
				if m.choice == 0 {
					m.quick = true
					m.config.Operation = "create"
					m.config.CPUCores = proxmoxQuickCPU
					m.config.RAMMiB = proxmoxQuickRAMMiB
					m.config.TargetDiskGiB = proxmoxQuickTargetGiB
					m.config.Channel = "stable"
					m.config.ReleaseProvider = defaultApplianceProvider
					m.config.ReleasesAPI = defaultApplianceReleasesAPI
					m.config.ReleaseBranch = ""
					m.config.ReleaseTag = ""
					m.config.ISOSHA256 = ""
					for _, key := range []string{"branch", "tag", "digest"} {
						input := m.inputs[key]
						input.SetValue("")
						m.inputs[key] = input
					}
					m.config.Freshness = "require-current"
					m.config.EraseConfirmed = false
					m.eraseChoice = 0
					m.page, m.cursor = 0, 0
					m.phase = proxmoxPhaseAdvanced
					m.focusAdvancedInput()
				} else {
					m.quick = false
					m.page, m.cursor = 0, 0
					m.phase = proxmoxPhaseAdvanced
					m.focusAdvancedInput()
				}
			case "q", "esc":
				return m, tea.Quit
			}
		}
		return m, nil

	case proxmoxPhaseAdvanced:
		return m.updateAdvanced(msg)

	case proxmoxPhaseReviewLoading:
		if result, ok := msg.(proxmoxExistingMsg); ok {
			if result.Err != nil {
				m.err = result.Err
				m.phase = proxmoxPhaseError
				return m, nil
			}
			m.existing = result.Existing
			m.config.Name = result.Existing.Name
			m.config.TargetStorage = strings.SplitN(result.Existing.TargetVolume, ":", 2)[0]
			m.config.TargetDiskGiB = result.Existing.TargetDiskGiB
			m.config.EraseConfirmed = false
			m.eraseChoice = 0
			m.phase = proxmoxPhaseReview
			return m, nil
		}
		return m, nil

	case proxmoxPhaseReview:
		if key, ok := msg.(tea.KeyMsg); ok {
			if key.String() == "esc" {
				m.page, m.cursor = m.lastConfigPage(), 0
				m.phase = proxmoxPhaseAdvanced
				m.focusAdvancedInput()
				return m, nil
			}
			switch key.String() {
			case "up", "down", "left", "right", "j", "k":
				m.eraseChoice = 1 - m.eraseChoice
				m.err = nil
				return m, nil
			case "n":
				m.eraseChoice = 0
				return m, nil
			case "y":
				m.eraseChoice = 1
				return m, nil
			}
			if key.String() == "enter" {
				if m.eraseChoice == 0 {
					m.err = fmt.Errorf("choose Yes to erase the installation drive, or Esc to go back")
					return m, nil
				}
				m.config.EraseConfirmed = true
				m.err = nil
				m.phase = proxmoxPhaseProgress
				m.stage = "Starting signed installation"
				m.progressCh = startProxmoxApplianceProvision(m.config, m.inventory)
				return m, tea.Batch(listenProxmoxProgress(m.progressCh), m.game.Init())
			}
		}
		return m, nil

	case proxmoxPhaseProgress:
		switch update := msg.(type) {
		case proxmoxProgressMsg:
			if !update.Open {
				if m.phase == proxmoxPhaseProgress {
					m.err = fmt.Errorf("Proxmox provisioner stopped before completion")
					m.phase = proxmoxPhaseError
				}
				return m, nil
			}
			m.stage = update.Progress.Stage
			m.detail = update.Progress.Detail
			m.percent = update.Progress.Percent
			if update.Progress.Err != nil {
				m.err = update.Progress.Err
				m.phase = proxmoxPhaseError
				return m, nil
			}
			if update.Progress.Done {
				m.resultURL = update.Progress.URL
				m.phase = proxmoxPhaseDone
				return m, m.bar.SetPercent(1)
			}
			return m, tea.Batch(listenProxmoxProgress(m.progressCh), m.bar.SetPercent(m.percent))
		case progress.FrameMsg:
			model, cmd := m.bar.Update(msg)
			m.bar = model.(progress.Model)
			return m, cmd
		case tea.KeyMsg:
			var cmd tea.Cmd
			m.game, cmd = m.game.Update(msg)
			return m, cmd
		default:
			var cmd tea.Cmd
			m.game, cmd = m.game.Update(msg)
			return m, cmd
		}

	case proxmoxPhaseDone, proxmoxPhaseError:
		if key, ok := msg.(tea.KeyMsg); ok && (key.String() == "enter" || key.String() == "q" || key.String() == "esc") {
			return m, tea.Quit
		}
	}
	return m, nil
}

func (m *proxmoxApplianceModel) initAdvancedInputs() {
	values := map[string]string{
		"vmid": strconv.Itoa(m.config.VMID), "name": m.config.Name,
		"cpu": strconv.Itoa(m.config.CPUCores), "ram": strconv.Itoa(m.config.RAMMiB),
		"target-size": strconv.Itoa(m.config.TargetDiskGiB),
		"address":     m.config.Network.Address, "gateway": m.config.Network.Gateway, "dns": m.config.Network.DNS,
		"releases-api": nonDefaultReleaseAPI(m.config.ReleaseProvider, m.config.ReleasesAPI),
		"branch":       m.config.ReleaseBranch, "tag": m.config.ReleaseTag, "digest": m.config.ISOSHA256, "keys": m.config.SSHKeysPath,
		"root-password": "", "root-password-confirm": "",
	}
	for key, value := range values {
		input := textinput.New()
		input.SetValue(value)
		input.Width = 42
		input.CharLimit = 256
		if key == "digest" {
			input.CharLimit = 64
		}
		if key == "root-password" || key == "root-password-confirm" {
			input.EchoMode = textinput.EchoPassword
			input.EchoCharacter = '•'
		}
		m.inputs[key] = input
	}
	m.releaseAPIs[m.config.ReleaseProvider] = m.inputs["releases-api"].Value()
	m.resizeAdvancedInputs()
}

func (m *proxmoxApplianceModel) resizeAdvancedInputs() {
	width := 42
	if m.width > 0 && m.width-30 < width {
		width = m.width - 30
	}
	if width < 16 {
		width = 16
	}
	for key, input := range m.inputs {
		input.Width = width
		m.inputs[key] = input
	}
}

func (m proxmoxApplianceModel) updateAdvanced(msg tea.Msg) (tea.Model, tea.Cmd) {
	key, isKey := msg.(tea.KeyMsg)
	fields := m.visibleAdvancedFields()
	if len(fields) == 0 {
		m.err = fmt.Errorf("installer page has no available controls")
		return m, nil
	}
	if m.cursor >= len(fields) {
		m.cursor = len(fields) - 1
	}
	if isKey {
		switch key.String() {
		case "esc":
			m.blurAdvancedInputs()
			m.err = nil
			if m.page == 0 {
				m.phase = proxmoxPhaseChoice
			} else {
				m.page--
				m.cursor = 0
				m.focusAdvancedInput()
			}
			return m, nil
		case "up", "shift+tab":
			m.applyAdvancedInputs()
			m.cursor = (m.cursor - 1 + len(fields)) % len(fields)
			m.focusAdvancedInput()
			return m, nil
		case "down", "tab":
			m.applyAdvancedInputs()
			m.cursor = (m.cursor + 1) % len(fields)
			m.focusAdvancedInput()
			return m, nil
		case "left", "right":
			field := fields[m.cursor]
			if field.Kind != "input" && field.Kind != "continue" {
				m.cycleAdvancedSelection(field.Kind, key.String() == "right")
				m.applyAdvancedInputs()
				m.focusAdvancedInput()
				return m, nil
			}
		case "enter":
			field := fields[m.cursor]
			if err := m.applyAdvancedInputs(); err != nil {
				m.err = err
				return m, nil
			}
			if field.Kind == "advanced-route" {
				m.quick = false
				m.page, m.cursor = 4, 0
				m.err = nil
				m.focusAdvancedInput()
				return m, nil
			}
			if field.Kind == "continue" {
				if err := m.validateAdvancedPage(); err != nil {
					m.err = err
					return m, nil
				}
				m.err = nil
				if m.page < m.lastConfigPage() {
					m.page++
					m.cursor = 0
					m.focusAdvancedInput()
					return m, nil
				}
				return m.prepareProxmoxReview()
			}
			m.cursor = (m.cursor + 1) % len(fields)
			m.focusAdvancedInput()
			return m, nil
		}
	}
	field := fields[m.cursor]
	if field.Kind == "input" {
		input := m.inputs[field.InputKey]
		var cmd tea.Cmd
		input, cmd = input.Update(msg)
		m.inputs[field.InputKey] = input
		return m, cmd
	}
	return m, nil
}

func (m *proxmoxApplianceModel) validateAdvancedPage() error {
	validateVM := func() error {
		if m.config.Operation != "create" && m.config.Operation != "reinstall" {
			return fmt.Errorf("operation must be Create or Reinstall")
		}
		if m.config.VMID < 100 || m.config.VMID > 999999999 {
			return fmt.Errorf("VMID must be between 100 and 999999999")
		}
		if m.config.Name == "" {
			return fmt.Errorf("VM name is required")
		}
		return nil
	}
	validateResources := func() error {
		if m.config.CPUCores < proxmoxMinimumCPU {
			return fmt.Errorf("YouEye requires at least %d CPU cores", proxmoxMinimumCPU)
		}
		if m.config.RAMMiB < proxmoxMinimumRAMMiB {
			return fmt.Errorf("YouEye requires at least %d MiB RAM", proxmoxMinimumRAMMiB)
		}
		if m.config.TargetDiskGiB < proxmoxMinimumTargetGiB {
			return fmt.Errorf("YouEye requires an installation drive of at least %d GiB", proxmoxMinimumTargetGiB)
		}
		return nil
	}
	validateStorage := func() error {
		if !containsString(m.inventory.ImageStorages, m.config.TargetStorage) || !containsString(m.inventory.ISOStorages, m.config.ISOStorage) {
			return fmt.Errorf("select available installation-drive and Installer-media storage")
		}
		return nil
	}
	validateNetwork := func() error {
		if !containsString(m.inventory.Bridges, m.config.Bridge) {
			return fmt.Errorf("select an available Proxmox network bridge")
		}
		answer := applianceAnswer{
			Schema: applianceAnswerSchema, Operation: "erase-install", EraseConfirmed: true,
			TransactionID: "00000000000000000000000000000000", TargetSerial: "TARGET",
			Network: m.config.Network, ReleasePolicy: defaultApplianceReleasePolicy(), Development: defaultDevelopmentAccessPolicy(),
		}
		if err := validateApplianceAnswer(answer); err != nil {
			return err
		}
		return nil
	}
	validateSoftware := func() error {
		if _, _, err := normalizeApplianceReleaseSource(m.config.ReleaseProvider, m.config.ReleasesAPI); err != nil {
			return err
		}
		switch m.config.Channel {
		case "stable", "development":
			if m.config.ReleaseBranch != "" || m.config.ReleaseTag != "" || m.config.ISOSHA256 != "" {
				return fmt.Errorf("this track cannot include branch or Exact fields")
			}
		case "branch":
			if !validApplianceReleaseBranch(m.config.ReleaseBranch) {
				return fmt.Errorf("enter a safe signed release branch")
			}
		case "exact":
			if !validExactApplianceReleaseTag(m.config.ReleaseTag) || !validSHA256Hex(m.config.ISOSHA256) {
				return fmt.Errorf("Exact requires a valid release tag and lowercase manifest SHA-256")
			}
		default:
			return fmt.Errorf("select Stable, Development, branch, or Exact")
		}
		return nil
	}
	validateSSH := func() error {
		preflight, err := loadProxmoxAuthorizedKeys(m.config)
		if err != nil {
			return err
		}
		m.keyPreflight = preflight
		return nil
	}
	validateDevelopment := func() error {
		policy, err := buildDevelopmentAccessPolicy(
			m.developmentSSH,
			m.inputs["root-password"].Value(),
			m.inputs["root-password-confirm"].Value(),
			m.config.Development,
		)
		if err != nil {
			return err
		}
		m.config.Development = policy
		for _, key := range []string{"root-password", "root-password-confirm"} {
			input := m.inputs[key]
			input.SetValue("")
			m.inputs[key] = input
		}
		return nil
	}

	if m.quick {
		switch m.page {
		case 0:
			return validateVM()
		case 1:
			return validateResources()
		case 2:
			if err := validateStorage(); err != nil {
				return err
			}
			return validateNetwork()
		case 3:
			return validateSoftware()
		case 4:
			if err := validateSSH(); err != nil {
				return err
			}
			return validateDevelopment()
		}
	}

	switch m.page {
	case 0:
		return validateVM()
	case 1:
		return validateResources()
	case 2:
		return validateStorage()
	case 3:
		return validateNetwork()
	case 4:
		return validateSoftware()
	case 5:
		return validateSSH()
	case 6:
		return validateDevelopment()
	}
	return nil
}

func (m proxmoxApplianceModel) prepareProxmoxReview() (tea.Model, tea.Cmd) {
	if err := m.applyAdvancedInputs(); err != nil {
		m.err = err
		return m, nil
	}
	if err := validateProxmoxApplianceConfig(m.config, m.inventory); err != nil {
		m.err = err
		return m, nil
	}
	m.err = nil
	m.blurAdvancedInputs()
	m.config.EraseConfirmed = false
	m.eraseChoice = 0
	if m.config.Operation == "reinstall" {
		m.phase = proxmoxPhaseReviewLoading
		vmid := m.config.VMID
		return m, func() tea.Msg {
			existing, err := inspectCompatibleProxmoxApplianceVM(vmid, execProxmoxCommandRunner{})
			return proxmoxExistingMsg{Existing: existing, Err: err}
		}
	}
	m.phase = proxmoxPhaseReview
	return m, nil
}

func (m *proxmoxApplianceModel) applyAdvancedInputs() error {
	parse := func(key, label string) (int, error) {
		value, err := strconv.Atoi(strings.TrimSpace(m.inputs[key].Value()))
		if err != nil {
			return 0, fmt.Errorf("%s must be a number", label)
		}
		return value, nil
	}
	var err error
	if m.config.VMID, err = parse("vmid", "VMID"); err != nil {
		return err
	}
	m.config.Name = strings.TrimSpace(m.inputs["name"].Value())
	if m.config.CPUCores, err = parse("cpu", "CPU cores"); err != nil {
		return err
	}
	if m.config.RAMMiB, err = parse("ram", "Memory"); err != nil {
		return err
	}
	if m.config.TargetDiskGiB, err = parse("target-size", "Installation drive"); err != nil {
		return err
	}
	m.config.Network.Address = strings.TrimSpace(m.inputs["address"].Value())
	m.config.Network.Gateway = strings.TrimSpace(m.inputs["gateway"].Value())
	m.config.Network.DNS = strings.TrimSpace(m.inputs["dns"].Value())
	if m.config.ReleaseProvider == defaultApplianceProvider {
		m.config.ReleasesAPI = defaultApplianceReleasesAPI
	} else {
		m.config.ReleasesAPI = strings.TrimSpace(m.inputs["releases-api"].Value())
		m.releaseAPIs[m.config.ReleaseProvider] = m.config.ReleasesAPI
	}
	m.config.ReleaseTag = strings.TrimSpace(m.inputs["tag"].Value())
	m.config.ReleaseBranch = strings.TrimSpace(m.inputs["branch"].Value())
	m.config.ISOSHA256 = strings.ToLower(strings.TrimSpace(m.inputs["digest"].Value()))
	m.config.SSHKeysPath = strings.TrimSpace(m.inputs["keys"].Value())
	return nil
}

func (m proxmoxApplianceModel) visibleAdvancedFields() []proxmoxFormField {
	if m.quick && m.page == 3 {
		return []proxmoxFormField{
			{Label: "Release source", Kind: "software-summary"},
			{Label: "Release track", Kind: "software-track-summary"},
			{Label: "Change policy", Kind: "advanced-route"},
			{Label: "Continue", Kind: "continue"},
		}
	}
	fields := make([]proxmoxFormField, 0, len(proxmoxAdvancedFields))
	for _, field := range proxmoxAdvancedFields {
		if !m.advancedFieldOnCurrentPage(field) {
			continue
		}
		if m.quick && field.Kind == "operation" {
			continue
		}
		if m.quick && m.page == 4 && field.Page == 4 && field.Kind == "continue" {
			continue
		}
		if (field.InputKey == "address" || field.InputKey == "gateway" || field.InputKey == "dns") && m.config.Network.Mode != "static" {
			continue
		}
		if (field.InputKey == "tag" || field.InputKey == "digest") && m.config.Channel != "exact" {
			continue
		}
		if field.InputKey == "branch" && m.config.Channel != "branch" {
			continue
		}
		if field.InputKey == "releases-api" && m.config.ReleaseProvider == defaultApplianceProvider {
			continue
		}
		fields = append(fields, field)
	}
	return fields
}

func (m proxmoxApplianceModel) advancedFieldOnCurrentPage(field proxmoxFormField) bool {
	if m.quick {
		switch m.page {
		case 0, 1, 2:
			return field.Page == m.page
		case 4:
			return field.Page == 4 || field.Page == 5
		default:
			return false
		}
	}
	switch m.page {
	case 0, 1:
		return field.Page == m.page
	case 2:
		return field.Page == 2 && (field.Kind == "target-storage" || field.Kind == "iso-storage" || field.Kind == "continue")
	case 3:
		return field.Page == 2 && field.Kind != "target-storage" && field.Kind != "iso-storage"
	case 4:
		return field.Page == 3
	case 5:
		return field.Page == 4
	case 6:
		return field.Page == 5
	default:
		return false
	}
}

func (m proxmoxApplianceModel) lastConfigPage() int {
	if m.quick {
		return 4
	}
	return 6
}

func (m *proxmoxApplianceModel) focusAdvancedInput() {
	m.blurAdvancedInputs()
	fields := m.visibleAdvancedFields()
	if len(fields) == 0 {
		return
	}
	if m.cursor >= len(fields) {
		m.cursor = len(fields) - 1
	}
	field := fields[m.cursor]
	if field.Kind == "input" {
		input := m.inputs[field.InputKey]
		input.Focus()
		m.inputs[field.InputKey] = input
	}
}

func (m *proxmoxApplianceModel) blurAdvancedInputs() {
	for key, input := range m.inputs {
		input.Blur()
		m.inputs[key] = input
	}
}

func (m *proxmoxApplianceModel) cycleAdvancedSelection(kind string, forward bool) {
	cycle := func(current string, values []string) string {
		index := 0
		for i, value := range values {
			if value == current {
				index = i
				break
			}
		}
		if forward {
			index = (index + 1) % len(values)
		} else {
			index = (index - 1 + len(values)) % len(values)
		}
		return values[index]
	}
	switch kind {
	case "operation":
		m.config.Operation = cycle(m.config.Operation, []string{"create", "reinstall"})
	case "target-storage":
		m.config.TargetStorage = cycle(m.config.TargetStorage, m.inventory.ImageStorages)
	case "iso-storage":
		m.config.ISOStorage = cycle(m.config.ISOStorage, m.inventory.ISOStorages)
	case "bridge":
		m.config.Bridge = cycle(m.config.Bridge, m.inventory.Bridges)
	case "network":
		m.config.Network.Mode = cycle(m.config.Network.Mode, []string{"dhcp", "static"})
	case "release-provider":
		current := m.config.ReleaseProvider
		if current != defaultApplianceProvider {
			m.releaseAPIs[current] = strings.TrimSpace(m.inputs["releases-api"].Value())
		}
		m.config.ReleaseProvider = cycle(current, []string{"github", "forgejo", "custom"})
		if m.config.ReleaseProvider == defaultApplianceProvider {
			m.config.ReleasesAPI = defaultApplianceReleasesAPI
			input := m.inputs["releases-api"]
			input.SetValue("")
			m.inputs["releases-api"] = input
		} else {
			value := m.releaseAPIs[m.config.ReleaseProvider]
			m.config.ReleasesAPI = value
			input := m.inputs["releases-api"]
			input.SetValue(value)
			m.inputs["releases-api"] = input
		}
	case "channel":
		m.config.Channel = cycle(m.config.Channel, []string{"stable", "development", "branch", "exact"})
		if m.config.Channel != "branch" {
			m.config.ReleaseBranch = ""
			branch := m.inputs["branch"]
			branch.SetValue("")
			m.inputs["branch"] = branch
		}
		if m.config.Channel != "exact" {
			m.config.ReleaseTag, m.config.ISOSHA256 = "", ""
			for _, key := range []string{"tag", "digest"} {
				input := m.inputs[key]
				input.SetValue("")
				m.inputs[key] = input
			}
		}
	case "freshness":
		m.config.Freshness = cycle(m.config.Freshness, []string{"require-current", "prefer-current"})
	case "ssh-toggle":
		m.config.ImportHostSSHKeys = !m.config.ImportHostSSHKeys
	case "development-local":
		// Root console login is always available and cannot be disabled here.
	case "development-ssh":
		m.developmentSSH = !m.developmentSSH
	}
}

func (m proxmoxApplianceModel) advancedFieldValue(field proxmoxFormField) string {
	if field.Kind == "input" {
		return m.inputs[field.InputKey].View()
	}
	switch field.Kind {
	case "operation":
		return strings.Title(m.config.Operation)
	case "target-storage":
		return m.config.TargetStorage
	case "iso-storage":
		return m.config.ISOStorage
	case "bridge":
		return m.config.Bridge
	case "network":
		return strings.ToUpper(m.config.Network.Mode)
	case "release-provider":
		return releaseProviderLabel(m.config.ReleaseProvider)
	case "channel":
		return strings.Title(m.config.Channel)
	case "freshness":
		if m.config.Freshness == "prefer-current" {
			return "Use media if current release is temporarily unavailable"
		}
		return "Require current signed release"
	case "ssh-toggle":
		if m.config.ImportHostSSHKeys {
			return "Import"
		}
		return "Do not import"
	case "development-local":
		return "Always available · password authenticated"
	case "development-ssh":
		if m.developmentSSH {
			return "Enabled · local network only"
		}
		return "Off"
	case "continue":
		if m.page == m.lastConfigPage() {
			return "Review installation"
		}
		return "Next"
	case "software-summary":
		return "Official GitHub"
	case "software-track-summary":
		return "Latest signed Stable bundle"
	case "advanced-route":
		return "Open Advanced software options"
	}
	return ""
}

func listenProxmoxProgress(channel <-chan proxmoxApplianceProgress) tea.Cmd {
	return func() tea.Msg {
		update, ok := <-channel
		return proxmoxProgressMsg{Progress: update, Open: ok}
	}
}

func (m proxmoxApplianceModel) View() string {
	var content string
	switch m.phase {
	case proxmoxPhaseLoading:
		content = m.centeredPanel("YouEye Installer", m.stage)
	case proxmoxPhaseChoice:
		quick := "  Quick install"
		advanced := "  Advanced"
		if m.choice == 0 {
			quick = theme.Selected.Render("› Quick install")
		} else {
			advanced = theme.Selected.Render("› Advanced")
		}
		body := strings.Join([]string{
			theme.Title.Render("YouEye Installer"), "",
			quick, theme.Dim.Render("  4 CPU · 8 GiB RAM · 128 GiB installation drive"), "",
			advanced, theme.Dim.Render("  VM, storage, network, release source, and reinstall controls"),
		}, "\n")
		content = theme.BoxAccent.Render(body)
	case proxmoxPhaseAdvanced:
		content = m.advancedView()
	case proxmoxPhaseReviewLoading:
		content = m.centeredPanel("Review reinstall", "Inspecting the exact existing VM and installation-drive identity")
	case proxmoxPhaseReview:
		content = m.reviewView()
	case proxmoxPhaseProgress:
		content = m.progressView()
	case proxmoxPhaseDone:
		content = m.centeredPanel("YouEye is ready", m.resultURL)
	case proxmoxPhaseError:
		detail := "Installation failed"
		if m.err != nil {
			detail = m.err.Error()
		}
		content = theme.BoxAccent.Render(strings.Join([]string{theme.Danger.Render("YouEye Installer"), "", theme.Body.Render(detail)}, "\n"))
	}
	if m.width > 0 {
		return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, content)
	}
	return content
}

func (m proxmoxApplianceModel) advancedView() string {
	fields := m.visibleAdvancedFields()
	visibleRows := 11
	if m.height > 0 && m.height-10 < visibleRows {
		visibleRows = m.height - 10
	}
	if visibleRows < 3 {
		visibleRows = 3
	}
	start := m.cursor - visibleRows/2
	if start < 0 {
		start = 0
	}
	end := start + visibleRows
	if end > len(fields) {
		end = len(fields)
		start = end - visibleRows
		if start < 0 {
			start = 0
		}
	}
	pageTitles := []string{"Operation and VM", "Resources", "Storage", "Network", "Software", "SSH keys", "Development access"}
	totalPages := 8
	journey := "Advanced"
	if m.quick {
		journey = "Quick"
		pageTitles = []string{"VM", "Resources", "Storage and network", "Software", "Access"}
		totalPages = 6
	}
	rows := []string{theme.Title.Render(fmt.Sprintf("%s installation · %s · %d/%d", journey, pageTitles[m.page], m.page+1, totalPages)), ""}
	for index := start; index < end; index++ {
		field := fields[index]
		prefix := "  "
		label := theme.Dim.Render(fmt.Sprintf("%-19s", field.Label))
		value := m.advancedFieldValue(field)
		if index == m.cursor {
			prefix = theme.Selected.Render("› ")
			label = theme.Body.Render(fmt.Sprintf("%-19s", field.Label))
		}
		rows = append(rows, prefix+label+" "+value)
	}
	if m.err != nil {
		rows = append(rows, "", theme.Danger.Render(m.err.Error()))
	}
	return theme.BoxAccent.Render(strings.Join(rows, "\n"))
}

func (m proxmoxApplianceModel) reviewView() string {
	rows := []string{
		theme.Title.Render(fmt.Sprintf("Review YouEye installation · %d/%d", m.lastConfigPage()+2, m.lastConfigPage()+2)), "",
		fmt.Sprintf("Operation          %s", strings.Title(m.config.Operation)),
		fmt.Sprintf("VM                 %d · %s", m.config.VMID, m.config.Name),
		fmt.Sprintf("Resources          %d CPU · %d MiB", m.config.CPUCores, m.config.RAMMiB),
		fmt.Sprintf("Drive              %s · %d GiB", m.config.TargetStorage, m.config.TargetDiskGiB),
		fmt.Sprintf("Network            %s · %s", m.config.Bridge, strings.ToUpper(m.config.Network.Mode)),
		fmt.Sprintf("Release source     %s", releaseProviderLabel(m.config.ReleaseProvider)),
		fmt.Sprintf("Release track      %s", strings.Title(m.config.Channel)),
	}
	if m.config.Channel == "branch" {
		rows = append(rows, fmt.Sprintf("Signed branch      %s", m.config.ReleaseBranch))
	}
	if m.config.Channel == "exact" {
		rows = append(rows, fmt.Sprintf("Exact release      %s", m.config.ReleaseTag))
	}
	rows = append(rows,
		fmt.Sprintf("SSH keys           %d compatible · %d skipped", len(m.keyPreflight.Accepted), m.keyPreflight.RejectedTotal()),
		fmt.Sprintf("Root console       %s", "Always available · password authenticated"),
		fmt.Sprintf("Root password SSH  %s", enabledLabel(m.config.Development.RootPasswordSSH)),
	)
	if m.config.TargetDiskGiB < proxmoxLowCapacityGiB {
		rows = append(rows, theme.Danger.Render(fmt.Sprintf("Low capacity       About %d GiB remains for apps and personal data.", estimatedProxmoxDataGiB(m.config.TargetDiskGiB))))
	}
	if m.config.Operation == "reinstall" {
		rows = append(rows,
			"",
			fmt.Sprintf("Drive target       %s · %d GiB", m.existing.TargetSerial, m.existing.TargetDiskGiB),
			theme.Dim.Render("Drive contents      "+summarizeProxmoxDiskContents(m.existing.TargetContents)),
		)
		if m.existing.RecordedRelease != "" {
			rows = append(rows, fmt.Sprintf("Recorded release    %s", m.existing.RecordedRelease))
		}
	}
	no := "  No, go back"
	yes := "  Yes, erase and install"
	if m.eraseChoice == 0 {
		no = theme.Selected.Render("› No, go back")
	} else {
		yes = theme.Selected.Render("› Yes, erase and install")
	}
	rows = append(rows,
		"",
		theme.Danger.Render("The installation drive will be completely erased."),
		no,
		yes,
	)
	if m.err != nil {
		rows = append(rows, "", theme.Danger.Render(m.err.Error()))
	}
	if available := m.height - 6; m.height > 0 && available >= 7 && len(rows) > available {
		tail := 6
		head := available - tail - 1
		if head < 2 {
			head = 2
		}
		rows = append(append(append([]string{}, rows[:head]...), theme.Dim.Render("… more verified details omitted on this short console …")), rows[len(rows)-tail:]...)
	}
	return theme.BoxAccent.Render(strings.Join(rows, "\n"))
}

func (m proxmoxApplianceModel) progressView() string {
	pct := theme.StatusBar.Render(fmt.Sprintf(" %3d%% ", int(m.percent*100)))
	rows := []string{
		theme.Title.Render("Installing YouEye"), "",
		m.game.View(), "",
		theme.Body.Render(m.stage),
		theme.Dim.Render(m.detail), "",
		pct + " " + m.bar.View(),
	}
	return strings.Join(rows, "\n")
}

func (m proxmoxApplianceModel) centeredPanel(title, detail string) string {
	return theme.BoxAccent.Render(strings.Join([]string{theme.Title.Render(title), "", theme.Body.Render(detail)}, "\n"))
}

// RunProxmoxAppliance launches the signed appliance host provisioner TUI.
func RunProxmoxAppliance(opts CLIOptions) error {
	program := tea.NewProgram(newProxmoxApplianceModel(opts), tea.WithAltScreen())
	if _, err := program.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "installer error: %v\n", err)
		return err
	}
	return nil
}
