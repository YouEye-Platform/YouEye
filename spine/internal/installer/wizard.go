package installer

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/YouEye-Platform/YouEye/spine/internal/installer/theme"
)

// ---------------------------------------------------------------------------
// Step kinds
// ---------------------------------------------------------------------------

type stepKind int

const (
	stepWelcome    stepKind = iota // logo + badge + "press enter"
	stepModeSelect                // LXC vs VM (Proxmox only)
	stepPathSelect                // Quick vs Advanced
	stepRadio                     // single-select from options
	stepText                      // single text input
	stepPassword                  // two masked inputs (pw + confirm)
	stepNumber                    // numeric input (with up/down)
	stepResources                 // 3 number fields on one screen
	stepToggle                    // grid of on/off toggles
	stepIPConfig                  // DHCP/Static radio + conditional fields
	stepDNS                       // two text fields
	stepSSH                       // toggle + conditional source
	stepConfirm                   // read-only summary
)

// ---------------------------------------------------------------------------
// Step definition
// ---------------------------------------------------------------------------

type wizOption struct {
	label string
	desc  string
}

type wizStep struct {
	kind    stepKind
	title   string
	options []wizOption // for radio / toggle / modeSelect / pathSelect
}

// ---------------------------------------------------------------------------
// Wizard model
// ---------------------------------------------------------------------------

type wizardModel struct {
	width, height int

	steps   []wizStep
	current int
	config  installConfig
	env     envInfo

	// Shared input state — reused across steps to avoid allocating dozens
	// of textinput models. We reinitialise them on step entry.
	inputs     []textinput.Model
	focusField int    // which input or radio cursor is active
	radioCur   int    // cursor for radio/toggle steps
	toggles    []bool // for toggle step
	pwMatch    bool

	done bool // all steps answered
}

// ---------------------------------------------------------------------------
// Step lists per mode + path — now built dynamically from envInfo
// ---------------------------------------------------------------------------

func welcomeStep() wizStep {
	return wizStep{kind: stepWelcome, title: "Welcome"}
}
func modeSelectStep() wizStep {
	return wizStep{kind: stepModeSelect, title: "Installation Mode", options: []wizOption{
		{"LXC Container", "Recommended — lightweight, fast, shared kernel"},
		{"Virtual Machine", "Full isolation, own kernel, more resources"},
	}}
}
func pathSelectStep() wizStep {
	return wizStep{kind: stepPathSelect, title: "Choose Your Adventure", options: []wizOption{
		{"Quick Install", "Uses sensible defaults, 3 questions only"},
		{"Advanced Setup", "Full control over every option"},
	}}
}

// Quick path steps — includes ID selection for Proxmox modes.
func quickSteps(mode installMode) []wizStep {
	steps := []wizStep{
		{kind: stepPassword, title: "Root Password"},
	}
	if mode == modeLXC {
		steps = append(steps, wizStep{kind: stepText, title: "Container ID"})
	} else if mode == modeVM {
		steps = append(steps, wizStep{kind: stepText, title: "VM ID"})
	}
	steps = append(steps,
		wizStep{kind: stepText, title: "Hostname"},
		wizStep{kind: stepConfirm, title: "Confirmation"},
	)
	return steps
}

// storagePoolOptions builds radio options from real detected pools.
func storagePoolOptions(pools []storagePool) []wizOption {
	if len(pools) == 0 {
		return []wizOption{{"local-lvm", "default"}}
	}
	var opts []wizOption
	for _, p := range pools {
		desc := fmt.Sprintf("%s · %s", strings.ToUpper(p.Type), p.FormatFree())
		opts = append(opts, wizOption{p.Name, desc})
	}
	return opts
}

// bridgeOptions builds radio options from detected bridges.
func bridgeOptions(bridges []string) []wizOption {
	if len(bridges) == 0 {
		return []wizOption{{"vmbr0", "default bridge"}}
	}
	var opts []wizOption
	for _, b := range bridges {
		opts = append(opts, wizOption{b, "network bridge"})
	}
	return opts
}

// advancedLXCSteps builds LXC wizard steps using real detection data.
func advancedLXCSteps(env envInfo) []wizStep {
	steps := []wizStep{
		{kind: stepRadio, title: "Container Type", options: []wizOption{
			{"Unprivileged", "Recommended — runs as non-root in the kernel"},
			{"Privileged", "Full root access, less secure"},
		}},
		{kind: stepPassword, title: "Root Password"},
		{kind: stepText, title: "Container ID"},
		{kind: stepText, title: "Hostname"},
		{kind: stepResources, title: "Resources"},
		{kind: stepRadio, title: "Storage Pool", options: storagePoolOptions(env.RootdirPools)},
	}

	// Template storage (only if different pools available)
	if len(env.VztmplPools) > 1 {
		steps = append(steps, wizStep{kind: stepRadio, title: "Template Storage", options: storagePoolOptions(env.VztmplPools)})
	}

	steps = append(steps,
		wizStep{kind: stepRadio, title: "Network Bridge", options: bridgeOptions(env.Bridges)},
		wizStep{kind: stepIPConfig, title: "IP Configuration"},
		wizStep{kind: stepDNS, title: "DNS"},
		wizStep{kind: stepSSH, title: "SSH Access"},
		wizStep{kind: stepToggle, title: "Container Features", options: []wizOption{
			{"FUSE", "Mount FUSE filesystems"},
			{"TUN/TAP", "Virtual network devices"},
			{"Nesting", "Run containers inside (default on)"},
			{"GPU Passthrough", "Access host GPU"},
			{"Keyctl", "Manage kernel keyrings"},
		}},
		wizStep{kind: stepText, title: "Timezone"},
		wizStep{kind: stepText, title: "Tags"},
		wizStep{kind: stepConfirm, title: "Confirmation"},
	)
	return steps
}

// advancedVMSteps builds VM wizard steps using real detection data.
func advancedVMSteps(env envInfo) []wizStep {
	return []wizStep{
		{kind: stepRadio, title: "Machine Type", options: []wizOption{
			{"q35", "Modern chipset, UEFI support"},
			{"i440fx", "Legacy chipset, maximum compatibility"},
		}},
		{kind: stepPassword, title: "Root Password"},
		{kind: stepText, title: "VM ID"},
		{kind: stepText, title: "Hostname"},
		{kind: stepResources, title: "Resources"},
		{kind: stepRadio, title: "Storage Pool", options: storagePoolOptions(env.ImagePools)},
		{kind: stepRadio, title: "Network Bridge", options: bridgeOptions(env.Bridges)},
		{kind: stepIPConfig, title: "IP Configuration"},
		{kind: stepDNS, title: "DNS"},
		{kind: stepSSH, title: "SSH Access"},
		{kind: stepRadio, title: "CPU Model", options: []wizOption{
			{"KVM64", "Maximum compatibility across hosts"},
			{"Host", "Pass-through host CPU (best performance)"},
		}},
		{kind: stepRadio, title: "Disk Cache", options: []wizOption{
			{"None", "Direct I/O — safest for data integrity"},
			{"Write Through", "Read cache only — good balance"},
		}},
		{kind: stepText, title: "Timezone"},
		{kind: stepText, title: "Tags"},
		{kind: stepRadio, title: "Start After Creation?", options: []wizOption{
			{"Yes", "Boot the VM immediately after setup"},
			{"No", "Create but leave powered off"},
		}},
		{kind: stepConfirm, title: "Confirmation"},
	}
}

// advancedHostSteps returns wizard steps for bare Linux install.
func advancedHostSteps() []wizStep {
	return []wizStep{
		{kind: stepPassword, title: "Root Password"},
		{kind: stepText, title: "Hostname"},
		{kind: stepResources, title: "Resources"},
		{kind: stepIPConfig, title: "IP Configuration"},
		{kind: stepText, title: "Timezone"},
		{kind: stepConfirm, title: "Confirmation"},
	}
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

func newWizardModel(env envInfo) wizardModel {
	w := wizardModel{
		config: newConfigFromEnv(env),
		env:    env,
	}
	// Proxmox: mode select → path select → steps.
	// No welcome screen — go straight to business.
	if env.IsProxmox {
		w.steps = []wizStep{modeSelectStep(), pathSelectStep()}
	} else {
		w.config.Mode = modeHost
		w.steps = []wizStep{pathSelectStep()}
	}
	// Remaining steps added when path is chosen (in advanceStep).
	w.initStep()
	return w
}

// ---------------------------------------------------------------------------
// Step initialisation — sets up inputs/cursors for the current step
// ---------------------------------------------------------------------------

func (w *wizardModel) initStep() {
	if w.current >= len(w.steps) {
		return
	}
	s := w.steps[w.current]
	w.focusField = 0
	w.radioCur = 0
	w.pwMatch = true
	w.inputs = nil
	w.toggles = nil

	switch s.kind {
	case stepPassword:
		pw := textinput.New()
		pw.Placeholder = "enter password"
		pw.EchoMode = textinput.EchoPassword
		pw.EchoCharacter = '*'
		pw.Focus()
		pw.Width = 30
		confirm := textinput.New()
		confirm.Placeholder = "confirm password"
		confirm.EchoMode = textinput.EchoPassword
		confirm.EchoCharacter = '*'
		confirm.Width = 30
		w.inputs = []textinput.Model{pw, confirm}

	case stepText:
		ti := textinput.New()
		ti.Focus()
		ti.Width = 40
		switch s.title {
		case "Hostname":
			ti.Placeholder = "youeye"
			ti.SetValue(w.config.Hostname)
		case "Container ID", "VM ID":
			ti.Placeholder = w.config.ContainerID
			ti.SetValue(w.config.ContainerID)
		case "Timezone":
			ti.Placeholder = "UTC"
			ti.SetValue(w.config.Timezone)
		case "Tags":
			ti.Placeholder = "youeye"
			ti.SetValue(w.config.Tags)
		}
		w.inputs = []textinput.Model{ti}

	case stepResources:
		disk := textinput.New()
		disk.Placeholder = "25"
		disk.SetValue(strconv.Itoa(w.config.DiskGB))
		disk.Width = 10
		disk.Focus()
		cpu := textinput.New()
		cpu.Placeholder = "4"
		cpu.SetValue(strconv.Itoa(w.config.CPUCores))
		cpu.Width = 10
		ram := textinput.New()
		ram.Placeholder = "5120"
		ram.SetValue(strconv.Itoa(w.config.RAMMB))
		ram.Width = 10
		w.inputs = []textinput.Model{disk, cpu, ram}

	case stepIPConfig:
		ip := textinput.New()
		ip.Placeholder = "10.0.0.50/24"
		ip.Width = 30
		gw := textinput.New()
		gw.Placeholder = "10.0.0.1"
		gw.Width = 30
		w.inputs = []textinput.Model{ip, gw}

	case stepDNS:
		search := textinput.New()
		search.Placeholder = "lan"
		search.SetValue(w.config.DNSSearch)
		search.Width = 30
		search.Focus()
		server := textinput.New()
		server.Placeholder = "inherit from host"
		server.SetValue(w.config.DNSServer)
		server.Width = 30
		w.inputs = []textinput.Model{search, server}

	case stepSSH:
		// radioCur 0 = disabled, 1 = enabled

	case stepToggle:
		w.toggles = []bool{
			w.config.FeatFUSE,
			w.config.FeatTUN,
			w.config.FeatNesting,
			w.config.FeatGPU,
			w.config.FeatKeyctl,
		}

	case stepRadio, stepModeSelect, stepPathSelect:
		// radioCur handles selection
	}
}

// ---------------------------------------------------------------------------
// Save current step answers into config
// ---------------------------------------------------------------------------

func (w *wizardModel) saveStep() {
	if w.current >= len(w.steps) {
		return
	}
	s := w.steps[w.current]

	switch s.kind {
	case stepModeSelect:
		if w.radioCur == 0 {
			w.config.Mode = modeLXC
		} else {
			w.config.Mode = modeVM
		}

	case stepPathSelect:
		if w.radioCur == 0 {
			w.config.Path = pathQuick
		} else {
			w.config.Path = pathAdvanced
		}
		// Now we know mode + path — append the remaining wizard steps.
		w.appendRemainingSteps()

	case stepRadio:
		val := ""
		if w.radioCur < len(s.options) {
			val = s.options[w.radioCur].label
		}
		switch s.title {
		case "Container Type":
			w.config.ContainerType = val
		case "Machine Type":
			w.config.MachineType = val
		case "Storage Pool":
			w.config.StoragePool = val
		case "Template Storage":
			w.config.TemplateStorage = val
		case "Network Bridge":
			w.config.NetworkBridge = val
		case "CPU Model":
			w.config.CPUModel = val
		case "Disk Cache":
			w.config.DiskCache = val
		case "Start After Creation?":
			w.config.StartAfter = (val == "Yes")
		}

	case stepPassword:
		if len(w.inputs) >= 1 {
			w.config.RootPassword = w.inputs[0].Value()
		}

	case stepText:
		if len(w.inputs) >= 1 {
			val := w.inputs[0].Value()
			switch s.title {
			case "Hostname":
				if val != "" {
					w.config.Hostname = val
				}
			case "Container ID", "VM ID":
				if val != "" {
					w.config.ContainerID = val
				}
			case "Timezone":
				if val != "" {
					w.config.Timezone = val
				}
			case "Tags":
				if val != "" {
					w.config.Tags = val
				}
			}
		}

	case stepResources:
		if len(w.inputs) >= 3 {
			if v, err := strconv.Atoi(w.inputs[0].Value()); err == nil && v > 0 {
				w.config.DiskGB = v
			}
			if v, err := strconv.Atoi(w.inputs[1].Value()); err == nil && v > 0 {
				w.config.CPUCores = v
			}
			if v, err := strconv.Atoi(w.inputs[2].Value()); err == nil && v > 0 {
				w.config.RAMMB = v
			}
		}

	case stepIPConfig:
		if w.radioCur == 0 {
			w.config.IPMode = "DHCP"
		} else {
			w.config.IPMode = "Static"
			if len(w.inputs) >= 2 {
				w.config.StaticIP = w.inputs[0].Value()
				w.config.Gateway = w.inputs[1].Value()
			}
		}

	case stepDNS:
		if len(w.inputs) >= 2 {
			if v := w.inputs[0].Value(); v != "" {
				w.config.DNSSearch = v
			}
			if v := w.inputs[1].Value(); v != "" {
				w.config.DNSServer = v
			}
		}

	case stepSSH:
		w.config.SSHEnabled = (w.radioCur == 1)

	case stepToggle:
		if len(w.toggles) >= 5 {
			w.config.FeatFUSE = w.toggles[0]
			w.config.FeatTUN = w.toggles[1]
			w.config.FeatNesting = w.toggles[2]
			w.config.FeatGPU = w.toggles[3]
			w.config.FeatKeyctl = w.toggles[4]
		}
	}
}

func (w *wizardModel) appendRemainingSteps() {
	switch {
	case w.config.Path == pathQuick:
		w.steps = append(w.steps, quickSteps(w.config.Mode)...)
	case w.config.Mode == modeLXC:
		w.steps = append(w.steps, advancedLXCSteps(w.env)...)
	case w.config.Mode == modeVM:
		w.steps = append(w.steps, advancedVMSteps(w.env)...)
	case w.config.Mode == modeHost:
		w.steps = append(w.steps, advancedHostSteps()...)
	}
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

func (w wizardModel) Init() tea.Cmd {
	if len(w.inputs) > 0 {
		return w.inputs[0].Focus()
	}
	return nil
}

func (w wizardModel) Update(msg tea.Msg) (wizardModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		w.width, w.height = msg.Width, msg.Height
		return w, nil

	case tea.KeyMsg:
		return w.handleKey(msg)
	}

	// Forward to active text input.
	if len(w.inputs) > 0 && w.focusField < len(w.inputs) {
		var cmd tea.Cmd
		w.inputs[w.focusField], cmd = w.inputs[w.focusField].Update(msg)
		return w, cmd
	}
	return w, nil
}

func (w wizardModel) handleKey(msg tea.KeyMsg) (wizardModel, tea.Cmd) {
	if w.current >= len(w.steps) {
		return w, nil
	}
	s := w.steps[w.current]
	key := msg.String()

	switch s.kind {
	case stepWelcome:
		if key == "enter" || key == " " {
			return w.advance()
		}

	case stepModeSelect, stepPathSelect, stepRadio:
		switch key {
		case "up", "k":
			if w.radioCur > 0 {
				w.radioCur--
			}
		case "down", "j":
			if w.radioCur < len(s.options)-1 {
				w.radioCur++
			}
		case "enter", " ":
			return w.advance()
		case "esc":
			return w.goBack()
		}

	case stepPassword:
		switch key {
		case "tab", "shift+tab":
			w.focusField = (w.focusField + 1) % 2
			cmds := make([]tea.Cmd, len(w.inputs))
			for i := range w.inputs {
				if i == w.focusField {
					cmds[i] = w.inputs[i].Focus()
				} else {
					w.inputs[i].Blur()
				}
			}
			return w, tea.Batch(cmds...)
		case "enter":
			if len(w.inputs) >= 2 {
				w.pwMatch = w.inputs[0].Value() == w.inputs[1].Value()
				if !w.pwMatch {
					return w, nil
				}
			}
			return w.advance()
		case "esc":
			return w.goBack()
		default:
			var cmd tea.Cmd
			w.inputs[w.focusField], cmd = w.inputs[w.focusField].Update(msg)
			return w, cmd
		}

	case stepText:
		switch key {
		case "enter":
			return w.advance()
		case "esc":
			return w.goBack()
		default:
			if len(w.inputs) > 0 {
				var cmd tea.Cmd
				w.inputs[0], cmd = w.inputs[0].Update(msg)
				return w, cmd
			}
		}

	case stepResources:
		switch key {
		case "tab":
			w.focusField = (w.focusField + 1) % 3
			cmds := make([]tea.Cmd, len(w.inputs))
			for i := range w.inputs {
				if i == w.focusField {
					cmds[i] = w.inputs[i].Focus()
				} else {
					w.inputs[i].Blur()
				}
			}
			return w, tea.Batch(cmds...)
		case "shift+tab":
			w.focusField = (w.focusField + 2) % 3
			cmds := make([]tea.Cmd, len(w.inputs))
			for i := range w.inputs {
				if i == w.focusField {
					cmds[i] = w.inputs[i].Focus()
				} else {
					w.inputs[i].Blur()
				}
			}
			return w, tea.Batch(cmds...)
		case "enter":
			return w.advance()
		case "esc":
			return w.goBack()
		default:
			var cmd tea.Cmd
			w.inputs[w.focusField], cmd = w.inputs[w.focusField].Update(msg)
			return w, cmd
		}

	case stepIPConfig:
		switch key {
		case "up", "k":
			if w.radioCur > 0 {
				w.radioCur--
			}
		case "down", "j":
			if w.radioCur < 1 {
				w.radioCur++
			}
		case "tab":
			if w.radioCur == 1 && len(w.inputs) > 0 {
				w.focusField = (w.focusField + 1) % len(w.inputs)
				cmds := make([]tea.Cmd, len(w.inputs))
				for i := range w.inputs {
					if i == w.focusField {
						cmds[i] = w.inputs[i].Focus()
					} else {
						w.inputs[i].Blur()
					}
				}
				return w, tea.Batch(cmds...)
			}
		case "enter":
			return w.advance()
		case "esc":
			return w.goBack()
		default:
			if w.radioCur == 1 && len(w.inputs) > 0 && w.focusField < len(w.inputs) {
				var cmd tea.Cmd
				w.inputs[w.focusField], cmd = w.inputs[w.focusField].Update(msg)
				return w, cmd
			}
		}

	case stepDNS:
		switch key {
		case "tab", "shift+tab":
			w.focusField = (w.focusField + 1) % 2
			cmds := make([]tea.Cmd, len(w.inputs))
			for i := range w.inputs {
				if i == w.focusField {
					cmds[i] = w.inputs[i].Focus()
				} else {
					w.inputs[i].Blur()
				}
			}
			return w, tea.Batch(cmds...)
		case "enter":
			return w.advance()
		case "esc":
			return w.goBack()
		default:
			if len(w.inputs) > 0 {
				var cmd tea.Cmd
				w.inputs[w.focusField], cmd = w.inputs[w.focusField].Update(msg)
				return w, cmd
			}
		}

	case stepSSH:
		switch key {
		case "up", "k":
			if w.radioCur > 0 {
				w.radioCur--
			}
		case "down", "j":
			if w.radioCur < 1 {
				w.radioCur++
			}
		case "enter":
			return w.advance()
		case "esc":
			return w.goBack()
		}

	case stepToggle:
		switch key {
		case "up", "k":
			if w.radioCur > 0 {
				w.radioCur--
			}
		case "down", "j":
			if w.radioCur < len(w.toggles)-1 {
				w.radioCur++
			}
		case " ":
			if w.radioCur < len(w.toggles) {
				w.toggles[w.radioCur] = !w.toggles[w.radioCur]
			}
		case "enter":
			return w.advance()
		case "esc":
			return w.goBack()
		}

	case stepConfirm:
		switch key {
		case "enter", " ":
			return w.advance()
		case "esc":
			return w.goBack()
		}
	}

	return w, nil
}

func (w wizardModel) advance() (wizardModel, tea.Cmd) {
	w.saveStep()
	w.current++
	if w.current >= len(w.steps) {
		w.done = true
		return w, nil
	}
	w.initStep()
	if len(w.inputs) > 0 {
		return w, w.inputs[0].Focus()
	}
	return w, nil
}

func (w wizardModel) goBack() (wizardModel, tea.Cmd) {
	if w.current > 0 {
		w.current--
		w.initStep()
		if len(w.inputs) > 0 {
			return w, w.inputs[0].Focus()
		}
	}
	return w, nil
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

func (w wizardModel) View() string {
	if w.current >= len(w.steps) {
		return ""
	}
	s := w.steps[w.current]

	var body string
	switch s.kind {
	case stepWelcome:
		body = w.viewWelcome()
	case stepModeSelect:
		body = w.viewRadioLike(s, "How would you like to install YouEye?")
	case stepPathSelect:
		body = w.viewRadioLike(s, "Choose your adventure:")
	case stepRadio:
		body = w.viewRadioLike(s, "")
	case stepPassword:
		body = w.viewPassword()
	case stepText:
		body = w.viewText(s)
	case stepResources:
		body = w.viewResources()
	case stepIPConfig:
		body = w.viewIPConfig()
	case stepDNS:
		body = w.viewDNS()
	case stepSSH:
		body = w.viewSSH()
	case stepToggle:
		body = w.viewToggle(s)
	case stepConfirm:
		body = w.viewConfirm()
	default:
		body = theme.Body.Render("(unknown step)")
	}

	// Step counter (skip for welcome).
	counter := ""
	if s.kind != stepWelcome {
		counter = theme.Dim.Render(fmt.Sprintf("Step %d of %d", w.current+1, len(w.steps)))
	}

	title := theme.Title.Render("  " + s.title + "  ")
	sep := theme.Dim.Render(strings.Repeat("─", 42))

	hint := w.hintForStep(s.kind)

	content := lipgloss.JoinVertical(lipgloss.Left,
		counter,
		title,
		sep,
		"",
		body,
		"",
		sep,
		hint,
	)
	boxed := theme.Box.Render(content)

	if w.width > 0 {
		return lipgloss.Place(w.width, w.height, lipgloss.Center, lipgloss.Center, boxed)
	}
	return boxed
}

func (w wizardModel) hintForStep(k stepKind) string {
	switch k {
	case stepWelcome:
		return theme.Hint.Render("  Press Enter to begin")
	case stepModeSelect, stepPathSelect, stepRadio:
		return theme.Hint.Render("  ↑/↓ select · Enter confirm · Esc back")
	case stepPassword:
		return theme.Hint.Render("  Tab switch field · Enter next · Esc back")
	case stepText:
		return theme.Hint.Render("  Type your value · Enter next · Esc back")
	case stepResources:
		return theme.Hint.Render("  Tab switch field · Enter next · Esc back")
	case stepToggle:
		return theme.Hint.Render("  ↑/↓ navigate · Space toggle · Enter next · Esc back")
	case stepIPConfig:
		return theme.Hint.Render("  ↑/↓ select mode · Tab fields · Enter next · Esc back")
	case stepDNS:
		return theme.Hint.Render("  Tab switch field · Enter next · Esc back")
	case stepSSH:
		return theme.Hint.Render("  ↑/↓ select · Enter next · Esc back")
	case stepConfirm:
		return theme.Hint.Render("  Enter to begin installation · Esc to go back")
	}
	return ""
}

// ---------------------------------------------------------------------------
// Individual step views
// ---------------------------------------------------------------------------

func (w wizardModel) viewWelcome() string {
	logo := theme.Title.Render(`
 __   __         ___
 \ \ / /__ _  _ | __|_  _ ___
  \ V / _ \ || || _|| || / -_)
   |_|\___/\_,_||___|\_,/ \___|`)

	badge := ""
	if w.env.IsProxmox {
		badge = theme.StatusBar.Render(fmt.Sprintf(" PROXMOX VE %s ", w.env.PVEVersion))
	} else if w.env.IsVM {
		badge = theme.StatusBar.Render(" VIRTUAL MACHINE ")
	} else {
		badge = theme.StatusBar.Render(" LINUX HOST ")
	}
	desc := theme.Body.Render("  Self-hosted personal cloud platform")
	ver := theme.Dim.Render("  Installer v0.3.1")

	return lipgloss.JoinVertical(lipgloss.Left,
		logo,
		"",
		"  "+badge,
		"",
		desc,
		ver,
	)
}

func (w wizardModel) viewRadioLike(s wizStep, prompt string) string {
	var rows []string
	if prompt != "" {
		rows = append(rows, theme.Body.Render("  "+prompt), "")
	}
	for i, opt := range s.options {
		cursor := "  "
		style := theme.Body
		if i == w.radioCur {
			cursor = theme.Selected.Render("> ")
			style = theme.Selected
		}
		label := style.Render(opt.label)
		desc := theme.Dim.Render("  " + opt.desc)
		rows = append(rows, "  "+cursor+label)
		rows = append(rows, "    "+desc)
	}
	return strings.Join(rows, "\n")
}

func (w wizardModel) viewPassword() string {
	var rows []string
	labels := []string{"Password:", "Confirm: "}
	for i, lbl := range labels {
		style := theme.Dim
		if i == w.focusField {
			style = theme.Body
		}
		row := fmt.Sprintf("  %s  %s", style.Render(fmt.Sprintf("%-10s", lbl)), w.inputs[i].View())
		rows = append(rows, row)
	}
	if !w.pwMatch {
		rows = append(rows, "", theme.Danger.Render("  Passwords don't match"))
	}
	if w.inputs[0].Value() == "" {
		rows = append(rows, "", theme.Dim.Render("  Leave blank for no password (auto-login)"))
	}
	return strings.Join(rows, "\n")
}

func (w wizardModel) viewText(s wizStep) string {
	hint := ""
	switch s.title {
	case "Hostname":
		hint = "Must be a valid RFC 1123 hostname (letters, digits, hyphens)"
	case "Container ID", "VM ID":
		hint = fmt.Sprintf("Numeric ID — next available: %s", w.config.ContainerID)
	case "Timezone":
		hint = "IANA timezone (e.g. America/New_York, Europe/Berlin)"
	case "Tags":
		hint = "Semicolon-separated tags for organization"
	}
	rows := []string{
		fmt.Sprintf("  %s  %s", theme.Body.Render(fmt.Sprintf("%-12s", s.title+":")), w.inputs[0].View()),
	}
	if hint != "" {
		rows = append(rows, "", "  "+theme.Dim.Render(hint))
	}
	return strings.Join(rows, "\n")
}

func (w wizardModel) viewResources() string {
	labels := []string{"Disk (GB):", "CPU Cores:", "RAM (MiB):"}
	var rows []string
	for i, lbl := range labels {
		style := theme.Dim
		if i == w.focusField {
			style = theme.Body
		}
		row := fmt.Sprintf("  %s  %s", style.Render(fmt.Sprintf("%-12s", lbl)), w.inputs[i].View())
		rows = append(rows, row)
	}
	return strings.Join(rows, "\n")
}

func (w wizardModel) viewIPConfig() string {
	modes := []string{"DHCP", "Static"}
	var rows []string
	for i, mode := range modes {
		cursor := "  "
		style := theme.Body
		if i == w.radioCur {
			cursor = theme.Selected.Render("> ")
			style = theme.Selected
		}
		rows = append(rows, "  "+cursor+style.Render(mode))
	}
	if w.radioCur == 1 {
		rows = append(rows, "")
		labels := []string{"IP/CIDR:", "Gateway:"}
		for i, lbl := range labels {
			style := theme.Dim
			if i == w.focusField {
				style = theme.Body
			}
			rows = append(rows, fmt.Sprintf("    %s  %s", style.Render(fmt.Sprintf("%-10s", lbl)), w.inputs[i].View()))
		}
	}
	return strings.Join(rows, "\n")
}

func (w wizardModel) viewDNS() string {
	labels := []string{"Search domain:", "DNS server:   "}
	var rows []string
	for i, lbl := range labels {
		style := theme.Dim
		if i == w.focusField {
			style = theme.Body
		}
		rows = append(rows, fmt.Sprintf("  %s  %s", style.Render(lbl), w.inputs[i].View()))
	}
	return strings.Join(rows, "\n")
}

func (w wizardModel) viewSSH() string {
	opts := []string{"Disabled", "Enabled"}
	var rows []string
	for i, opt := range opts {
		cursor := "  "
		style := theme.Body
		if i == w.radioCur {
			cursor = theme.Selected.Render("> ")
			style = theme.Selected
		}
		rows = append(rows, "  "+cursor+style.Render(opt))
	}
	if w.radioCur == 1 {
		rows = append(rows, "", theme.Dim.Render("    Key source: Import from host"))
	}
	return strings.Join(rows, "\n")
}

func (w wizardModel) viewToggle(s wizStep) string {
	var rows []string
	for i, opt := range s.options {
		check := "[ ]"
		if i < len(w.toggles) && w.toggles[i] {
			check = lipgloss.NewStyle().Foreground(theme.NeonGreen).Render("[✓]")
		}
		cursor := "  "
		style := theme.Body
		if i == w.radioCur {
			cursor = theme.Selected.Render("> ")
			style = theme.Selected
		}
		label := style.Render(opt.label)
		desc := theme.Dim.Render("  " + opt.desc)
		rows = append(rows, fmt.Sprintf("  %s%s %s  %s", cursor, check, label, desc))
	}
	return strings.Join(rows, "\n")
}

func (w wizardModel) viewConfirm() string {
	c := w.config
	var rows []string
	add := func(label, value string) {
		rows = append(rows, fmt.Sprintf("  %-20s %s",
			theme.Dim.Render(label+":"),
			theme.Body.Render(value)))
	}

	add("Install Mode", c.Mode.String())
	if c.Mode == modeLXC {
		add("Container Type", c.ContainerType)
	}
	if c.Mode == modeVM {
		add("Machine Type", c.MachineType)
	}

	pw := "(none)"
	if c.RootPassword != "" {
		pw = strings.Repeat("*", len(c.RootPassword))
	}
	add("Root Password", pw)

	if c.Mode != modeHost {
		add("ID", c.ContainerID)
	}
	add("Hostname", c.Hostname)
	add("Disk", fmt.Sprintf("%d GB", c.DiskGB))
	add("CPU", fmt.Sprintf("%d cores", c.CPUCores))
	add("RAM", fmt.Sprintf("%d MiB", c.RAMMB))

	if c.Path == pathAdvanced {
		if c.Mode != modeHost {
			add("Storage", c.StoragePool)
			if c.Mode == modeLXC && c.TemplateStorage != "" {
				add("Template Storage", c.TemplateStorage)
			}
			add("Bridge", c.NetworkBridge)
		}
		add("IP", c.IPMode)
		if c.IPMode == "Static" {
			add("  Address", c.StaticIP)
			add("  Gateway", c.Gateway)
		}
		if c.Mode != modeHost {
			add("DNS Search", c.DNSSearch)
			add("DNS Server", c.DNSServer)
			ssh := "Disabled"
			if c.SSHEnabled {
				ssh = "Enabled"
			}
			add("SSH", ssh)
		}
		if c.Mode == modeLXC {
			var feats []string
			if c.FeatFUSE {
				feats = append(feats, "FUSE")
			}
			if c.FeatTUN {
				feats = append(feats, "TUN")
			}
			if c.FeatNesting {
				feats = append(feats, "Nesting")
			}
			if c.FeatGPU {
				feats = append(feats, "GPU")
			}
			if c.FeatKeyctl {
				feats = append(feats, "Keyctl")
			}
			if len(feats) == 0 {
				feats = []string{"(none)"}
			}
			add("Features", strings.Join(feats, ", "))
		}
		if c.Mode == modeVM {
			add("CPU Model", c.CPUModel)
			add("Disk Cache", c.DiskCache)
			start := "No"
			if c.StartAfter {
				start = "Yes"
			}
			add("Start After", start)
		}
		add("Timezone", c.Timezone)
		add("Tags", c.Tags)
	}

	rows = append(rows, "")
	rows = append(rows, theme.Selected.Render("  Press Enter to begin installation"))

	return strings.Join(rows, "\n")
}
