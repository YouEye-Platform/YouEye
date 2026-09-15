package installer

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/youeye-platform/YouEye/appliance/ordering"
	"github.com/youeye-platform/YouEye/installer/internal/installer/theme"
)

const defaultInteractiveApplianceAnswerPath = "/run/youeye-appliance/interactive-answer.json"

type applianceWizardStage int

const (
	applianceWizardLoading applianceWizardStage = iota
	applianceWizardTarget
	applianceWizardOperation
	applianceWizardNetwork
	applianceWizardRelease
	applianceWizardSSH
	applianceWizardDevelopment
	applianceWizardReview
	applianceWizardErase
)

type applianceWizardLoadedMsg struct {
	bundle           verifiedApplianceBundle
	disks            []applianceDisk
	adapters         []applianceNetworkAdapter
	installed        map[string]installedApplianceIdentity
	identityWarnings map[string]string
	err              error
}

type applianceWizardModel struct {
	width, height int
	config        installConfig
	runner        applianceCommandRunner
	answerPath    string

	stage    applianceWizardStage
	bundle   verifiedApplianceBundle
	disks    []applianceDisk
	adapters []applianceNetworkAdapter

	installed        map[string]installedApplianceIdentity
	identityWarnings map[string]string
	err              error

	targetCur      int
	operationCur   int
	networkCur     int
	networkAdapter int
	releaseCur     int
	sshCur         int
	developmentCur int

	networkInputs     []textinput.Model
	networkFocus      int
	sshInput          textinput.Model
	releaseInputs     map[string]textinput.Model
	releaseFocus      int
	releaseProvider   string
	releaseFreshness  string
	developmentInputs []textinput.Model
	developmentSSH    bool
	developmentPolicy developmentAccessPolicy
	eraseCur          int
	inputErr          string
	done              bool
}

func newApplianceWizardModel(cfg installConfig, runner applianceCommandRunner) applianceWizardModel {
	address := textinput.New()
	address.Placeholder = "192.0.2.10/24"
	address.Width = 30
	gateway := textinput.New()
	gateway.Placeholder = "192.0.2.1"
	gateway.Width = 30
	dns := textinput.New()
	dns.Placeholder = "192.0.2.53"
	dns.Width = 30
	sshKey := textinput.New()
	sshKey.Placeholder = "ssh-ed25519 AAAA..."
	sshKey.Width = 64
	releaseInputs := make(map[string]textinput.Model)
	for _, key := range []string{"api", "branch", "tag", "digest"} {
		input := textinput.New()
		input.Width = 52
		input.CharLimit = 256
		if key == "digest" {
			input.CharLimit = 64
		}
		releaseInputs[key] = input
	}
	password := textinput.New()
	password.EchoMode = textinput.EchoPassword
	password.EchoCharacter = '•'
	password.Width = 36
	password.CharLimit = 256
	confirm := password
	return applianceWizardModel{
		config: cfg, runner: runner, answerPath: defaultInteractiveApplianceAnswerPath,
		stage: applianceWizardLoading, networkInputs: []textinput.Model{address, gateway, dns},
		sshInput: sshKey, releaseInputs: releaseInputs, releaseProvider: defaultApplianceProvider,
		releaseFreshness: "require-current", developmentInputs: []textinput.Model{password, confirm},
		developmentPolicy: defaultDevelopmentAccessPolicy(),
		developmentCur:    4,
	}
}

func (w applianceWizardModel) Init() tea.Cmd {
	return func() tea.Msg {
		bundle, err := verifyApplianceBundle(w.config.ApplianceManifestPath, w.config.ApplianceSignaturePath, w.config.ApplianceTrustKeyPath)
		if err != nil {
			return applianceWizardLoadedMsg{err: err}
		}
		root := bundle.Assets["system-root"].Manifest
		rootBytes := root.UncompressedSizeBytes
		if rootBytes == 0 {
			rootBytes = root.SizeBytes
		}
		if _, err := applianceRootSlotSize(rootBytes); err != nil {
			return applianceWizardLoadedMsg{err: err}
		}
		disks, err := discoverApplianceDisks(w.runner)
		if err != nil {
			return applianceWizardLoadedMsg{err: err}
		}
		adapters, err := discoverApplianceNetworkAdapters()
		if err != nil {
			return applianceWizardLoadedMsg{err: fmt.Errorf("discover wired network adapters: %w", err)}
		}
		installed := make(map[string]installedApplianceIdentity)
		warnings := make(map[string]string)
		for _, disk := range disks {
			if len(nonBlankSignatures(disk.Signatures)) == 0 {
				continue
			}
			identity, identityErr := inspectInstalledApplianceIdentity(w.runner, disk, w.config.ApplianceTrustKeyPath)
			if identityErr != nil {
				warnings[disk.Path] = "Existing YouEye metadata is unreadable or untrusted; full erase remains available."
				continue
			}
			if identity != nil {
				installed[disk.Path] = *identity
			}
		}
		return applianceWizardLoadedMsg{bundle: bundle, disks: disks, adapters: adapters, installed: installed, identityWarnings: warnings}
	}
}

func (w applianceWizardModel) Update(msg tea.Msg) (applianceWizardModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		w.width, w.height = msg.Width, msg.Height
		return w, nil
	case applianceWizardLoadedMsg:
		w.err = msg.err
		if msg.err != nil {
			return w, nil
		}
		w.bundle, w.disks, w.adapters = msg.bundle, msg.disks, msg.adapters
		w.installed, w.identityWarnings = msg.installed, msg.identityWarnings
		w.stage = applianceWizardTarget
		w.targetCur = w.firstValidDisk()
		if w.targetCur < 0 {
			w.targetCur = 0
			w.inputErr = "No supported installation drive is available."
		}
		return w, nil
	case tea.KeyMsg:
		return w.handleKey(msg)
	}
	return w, nil
}

func (w applianceWizardModel) atFirstStep() bool {
	return w.stage == applianceWizardLoading || w.stage == applianceWizardTarget
}

func (w applianceWizardModel) handleKey(msg tea.KeyMsg) (applianceWizardModel, tea.Cmd) {
	key := msg.String()
	if w.err != nil {
		return w, nil
	}
	switch w.stage {
	case applianceWizardTarget:
		return w.handleDiskKey(key)
	case applianceWizardOperation:
		return w.handleOperationKey(key)
	case applianceWizardNetwork:
		return w.handleNetworkKey(msg)
	case applianceWizardRelease:
		return w.handleReleaseKey(msg)
	case applianceWizardSSH:
		return w.handleSSHKey(msg)
	case applianceWizardDevelopment:
		return w.handleDevelopmentKey(msg)
	case applianceWizardReview:
		switch key {
		case "esc":
			w.stage = applianceWizardDevelopment
		case "enter", " ":
			w.stage = applianceWizardErase
			w.eraseCur = 0
			w.inputErr = ""
		}
	case applianceWizardErase:
		switch key {
		case "esc":
			w.stage = applianceWizardReview
			w.inputErr = ""
		case "up", "down", "left", "right", "j", "k":
			w.eraseCur = 1 - w.eraseCur
			w.inputErr = ""
		case "n":
			w.eraseCur = 0
		case "y":
			w.eraseCur = 1
		case "enter":
			if w.eraseCur == 0 {
				w.stage = applianceWizardReview
				w.inputErr = "Installation cancelled. No disks were changed."
				return w, nil
			}
			return w.finish()
		}
	}
	return w, nil
}

func (w applianceWizardModel) handleDiskKey(key string) (applianceWizardModel, tea.Cmd) {
	cur := &w.targetCur
	switch key {
	case "up", "k":
		if *cur > 0 {
			*cur--
		}
		w.inputErr = ""
	case "down", "j":
		if *cur < len(w.disks)-1 {
			*cur++
		}
		w.inputErr = ""
	case "enter", " ":
		if len(w.disks) == 0 || *cur < 0 || *cur >= len(w.disks) {
			w.inputErr = "No disk is selected."
			return w, nil
		}
		if err := w.diskCandidateError(*cur); err != nil {
			w.inputErr = err.Error()
			return w, nil
		}
		w.inputErr = ""
		if _, ok := w.installed[w.disks[*cur].Path]; ok {
			w.stage = applianceWizardOperation
			w.operationCur = 0
			if w.preserveEligibility() != nil {
				w.operationCur = 1
			}
		} else {
			w.stage = applianceWizardNetwork
		}
	}
	return w, nil
}

func (w applianceWizardModel) handleOperationKey(key string) (applianceWizardModel, tea.Cmd) {
	switch key {
	case "up", "down", "j", "k":
		w.operationCur = 1 - w.operationCur
		w.inputErr = ""
	case "esc":
		w.stage = applianceWizardTarget
		w.inputErr = ""
	case "enter", " ":
		if w.operationCur == 0 {
			if err := w.preserveEligibility(); err != nil {
				w.inputErr = err.Error()
				return w, nil
			}
		}
		w.stage = applianceWizardNetwork
		w.inputErr = ""
	}
	return w, nil
}

func (w applianceWizardModel) handleNetworkKey(msg tea.KeyMsg) (applianceWizardModel, tea.Cmd) {
	key := msg.String()
	switch key {
	case "a":
		if len(w.adapters) > 1 {
			w.networkAdapter = (w.networkAdapter + 1) % len(w.adapters)
		}
		w.inputErr = ""
	case "up":
		w.networkCur = 0
		w.blurNetworkInputs()
		w.inputErr = ""
	case "down":
		w.networkCur = 1
		w.inputErr = ""
		return w, w.focusNetworkInput(0)
	case "tab":
		if w.networkCur == 1 {
			return w, w.focusNetworkInput((w.networkFocus + 1) % len(w.networkInputs))
		}
	case "shift+tab":
		if w.networkCur == 1 {
			return w, w.focusNetworkInput((w.networkFocus + len(w.networkInputs) - 1) % len(w.networkInputs))
		}
	case "esc":
		w.blurNetworkInputs()
		if _, ok := w.installed[w.disks[w.targetCur].Path]; ok {
			w.stage = applianceWizardOperation
		} else {
			w.stage = applianceWizardTarget
		}
		w.inputErr = ""
	case "enter":
		if _, err := w.currentAnswer(true, "00000000000000000000000000000000"); err != nil {
			w.inputErr = err.Error()
			return w, nil
		}
		w.blurNetworkInputs()
		w.stage = applianceWizardRelease
		w.inputErr = ""
	default:
		if w.networkCur == 1 {
			w.inputErr = ""
			var cmd tea.Cmd
			w.networkInputs[w.networkFocus], cmd = w.networkInputs[w.networkFocus].Update(msg)
			return w, cmd
		}
	}
	return w, nil
}

func (w applianceWizardModel) releaseInputKeys() []string {
	keys := []string{}
	if w.releaseProvider != defaultApplianceProvider {
		keys = append(keys, "api")
	}
	switch w.releaseCur {
	case 2:
		keys = append(keys, "branch")
	case 3:
		keys = append(keys, "tag", "digest")
	}
	return keys
}

func (w applianceWizardModel) handleReleaseKey(msg tea.KeyMsg) (applianceWizardModel, tea.Cmd) {
	key := msg.String()
	inputKeys := w.releaseInputKeys()
	switch key {
	case "up", "k":
		w.releaseCur = (w.releaseCur + 3) % 4
		w.blurReleaseInputs()
		w.inputErr = ""
	case "down", "j":
		w.releaseCur = (w.releaseCur + 1) % 4
		w.blurReleaseInputs()
		w.inputErr = ""
	case "left", "right":
		providers := []string{"github", "forgejo", "custom"}
		index := 0
		for candidate, provider := range providers {
			if provider == w.releaseProvider {
				index = candidate
			}
		}
		if key == "right" {
			index = (index + 1) % len(providers)
		} else {
			index = (index + len(providers) - 1) % len(providers)
		}
		w.releaseProvider = providers[index]
		w.blurReleaseInputs()
		w.inputErr = ""
	case "f":
		if w.releaseFreshness == "require-current" {
			w.releaseFreshness = "prefer-current"
		} else {
			w.releaseFreshness = "require-current"
		}
	case "tab":
		if len(inputKeys) > 0 {
			w.releaseFocus = (w.releaseFocus + 1) % len(inputKeys)
			return w, w.focusReleaseInput(inputKeys[w.releaseFocus])
		}
	case "shift+tab":
		if len(inputKeys) > 0 {
			w.releaseFocus = (w.releaseFocus + len(inputKeys) - 1) % len(inputKeys)
			return w, w.focusReleaseInput(inputKeys[w.releaseFocus])
		}
	case "esc":
		w.blurReleaseInputs()
		w.stage = applianceWizardNetwork
		w.inputErr = ""
	case "enter":
		if _, err := w.currentAnswer(true, "00000000000000000000000000000000"); err != nil {
			w.inputErr = err.Error()
			return w, nil
		}
		w.blurReleaseInputs()
		w.stage = applianceWizardSSH
		w.inputErr = ""
	default:
		if len(inputKeys) > 0 {
			if w.releaseFocus >= len(inputKeys) {
				w.releaseFocus = 0
			}
			inputKey := inputKeys[w.releaseFocus]
			input := w.releaseInputs[inputKey]
			var cmd tea.Cmd
			input, cmd = input.Update(msg)
			w.releaseInputs[inputKey] = input
			w.inputErr = ""
			return w, cmd
		}
	}
	return w, nil
}

func (w applianceWizardModel) handleSSHKey(msg tea.KeyMsg) (applianceWizardModel, tea.Cmd) {
	key := msg.String()
	switch key {
	case "up":
		w.sshCur = 0
		w.sshInput.Blur()
		w.inputErr = ""
	case "down":
		w.sshCur = 1
		w.inputErr = ""
		return w, w.sshInput.Focus()
	case "esc":
		w.sshInput.Blur()
		w.stage = applianceWizardRelease
		w.inputErr = ""
	case "enter":
		if w.sshCur == 1 && strings.TrimSpace(w.sshInput.Value()) == "" {
			w.inputErr = "Paste a public SSH key, or select No SSH key."
			return w, nil
		}
		if _, err := w.currentAnswer(true, "00000000000000000000000000000000"); err != nil {
			w.inputErr = err.Error()
			return w, nil
		}
		w.sshInput.Blur()
		w.stage = applianceWizardDevelopment
		w.inputErr = ""
	default:
		if w.sshCur == 1 {
			w.inputErr = ""
			var cmd tea.Cmd
			w.sshInput, cmd = w.sshInput.Update(msg)
			return w, cmd
		}
	}
	return w, nil
}

func (w applianceWizardModel) handleDevelopmentKey(msg tea.KeyMsg) (applianceWizardModel, tea.Cmd) {
	key := msg.String()
	switch key {
	case "up", "shift+tab":
		w.developmentCur = (w.developmentCur + 4) % 5
		return w, w.focusDevelopmentInput()
	case "down", "tab":
		w.developmentCur = (w.developmentCur + 1) % 5
		return w, w.focusDevelopmentInput()
	case "left", "right", " ":
		if w.developmentCur == 1 {
			w.developmentSSH = !w.developmentSSH
		}
		w.inputErr = ""
	case "esc":
		w.blurDevelopmentInputs()
		w.stage = applianceWizardSSH
		w.inputErr = ""
	case "enter":
		if w.developmentCur != 4 {
			if w.developmentCur == 1 {
				w.developmentSSH = !w.developmentSSH
			}
			w.developmentCur = (w.developmentCur + 1) % 5
			return w, w.focusDevelopmentInput()
		}
		policy, err := w.buildDevelopmentPolicy()
		if err != nil {
			w.inputErr = err.Error()
			return w, nil
		}
		w.developmentPolicy = policy
		w.blurDevelopmentInputs()
		for index := range w.developmentInputs {
			w.developmentInputs[index].SetValue("")
		}
		w.stage = applianceWizardReview
		w.inputErr = ""
	default:
		if w.developmentCur == 2 || w.developmentCur == 3 {
			index := w.developmentCur - 2
			input := w.developmentInputs[index]
			var cmd tea.Cmd
			input, cmd = input.Update(msg)
			w.developmentInputs[index] = input
			w.inputErr = ""
			return w, cmd
		}
	}
	return w, nil
}

func (w applianceWizardModel) buildDevelopmentPolicy() (developmentAccessPolicy, error) {
	return buildDevelopmentAccessPolicy(
		w.developmentSSH,
		w.developmentInputs[0].Value(),
		w.developmentInputs[1].Value(),
		w.developmentPolicy,
	)
}

func (w *applianceWizardModel) blurNetworkInputs() {
	for i := range w.networkInputs {
		w.networkInputs[i].Blur()
	}
}

func (w *applianceWizardModel) focusNetworkInput(index int) tea.Cmd {
	w.networkFocus = index
	var focused tea.Cmd
	for i := range w.networkInputs {
		if i == index {
			focused = w.networkInputs[i].Focus()
		} else {
			w.networkInputs[i].Blur()
		}
	}
	return focused
}

func (w *applianceWizardModel) blurReleaseInputs() {
	for key, input := range w.releaseInputs {
		input.Blur()
		w.releaseInputs[key] = input
	}
}

func (w *applianceWizardModel) focusReleaseInput(key string) tea.Cmd {
	w.blurReleaseInputs()
	input := w.releaseInputs[key]
	command := input.Focus()
	w.releaseInputs[key] = input
	return command
}

func (w *applianceWizardModel) blurDevelopmentInputs() {
	for index := range w.developmentInputs {
		w.developmentInputs[index].Blur()
	}
}

func (w *applianceWizardModel) focusDevelopmentInput() tea.Cmd {
	w.blurDevelopmentInputs()
	if w.developmentCur != 2 && w.developmentCur != 3 {
		return nil
	}
	return w.developmentInputs[w.developmentCur-2].Focus()
}

func (w applianceWizardModel) firstValidDisk() int {
	for i := range w.disks {
		if w.diskCandidateError(i) == nil {
			return i
		}
	}
	return -1
}

func (w applianceWizardModel) diskCandidateError(index int) error {
	if index < 0 || index >= len(w.disks) {
		return fmt.Errorf("no installation drive is selected")
	}
	disk := w.disks[index]
	serial := strings.TrimSpace(disk.Serial)
	if serial == "" {
		return fmt.Errorf("%s has no stable serial identity", disk.Path)
	}
	matches := 0
	for _, candidate := range w.disks {
		if strings.EqualFold(strings.TrimSpace(candidate.Serial), serial) {
			matches++
		}
	}
	if matches != 1 {
		return fmt.Errorf("serial %q is duplicated across %d disks", serial, matches)
	}
	if err := validateApplianceTargetDisk("installation drive", disk, true); err != nil {
		return err
	}
	if disk.SizeBytes < applianceTargetMinBytes {
		return fmt.Errorf("installation drive needs at least %s; %s is %s", formatBytes(applianceTargetMinBytes), disk.Path, formatBytes(disk.SizeBytes))
	}
	return nil
}

func (w applianceWizardModel) selectedDisk() (applianceDisk, error) {
	if err := w.diskCandidateError(w.targetCur); err != nil {
		return applianceDisk{}, err
	}
	return w.disks[w.targetCur], nil
}

func (w applianceWizardModel) networkAnswer() applianceAnswerNetwork {
	adapterMAC := ""
	if w.networkAdapter >= 0 && w.networkAdapter < len(w.adapters) {
		adapterMAC = w.adapters[w.networkAdapter].MAC
	}
	if w.networkCur == 0 {
		return applianceAnswerNetwork{Mode: "dhcp", AdapterMAC: adapterMAC}
	}
	return applianceAnswerNetwork{
		Mode: "static", AdapterMAC: adapterMAC, Address: strings.TrimSpace(w.networkInputs[0].Value()),
		Gateway: strings.TrimSpace(w.networkInputs[1].Value()), DNS: strings.TrimSpace(w.networkInputs[2].Value()),
	}
}

func (w applianceWizardModel) releasePolicyAnswer() applianceReleasePolicy {
	policy := applianceReleasePolicy{
		Schema: releasePolicySchema, Provider: w.releaseProvider,
		Mode: "track", Freshness: w.releaseFreshness,
	}
	if w.releaseProvider != defaultApplianceProvider {
		policy.ReleasesAPI = strings.TrimSpace(w.releaseInputs["api"].Value())
	}
	switch w.releaseCur {
	case 0:
		policy.Track = "stable"
	case 1:
		policy.Track = "development"
	case 2:
		policy.Track = "branch"
		policy.Branch = strings.TrimSpace(w.releaseInputs["branch"].Value())
	case 3:
		policy.Mode = "exact"
		policy.ExactTag = strings.TrimSpace(w.releaseInputs["tag"].Value())
		policy.ManifestSHA256 = strings.ToLower(strings.TrimSpace(w.releaseInputs["digest"].Value()))
	}
	return policy
}

func (w applianceWizardModel) currentAnswer(eraseConfirmed bool, transactionID string) (applianceAnswer, error) {
	target, err := w.selectedDisk()
	if err != nil {
		return applianceAnswer{}, err
	}
	operation := "erase-install"
	if _, ok := w.installed[target.Path]; ok && w.operationCur == 0 {
		if err := w.preserveEligibility(); err != nil {
			return applianceAnswer{}, err
		}
		operation = "preserve-reinstall"
		eraseConfirmed = false
	}
	answer := applianceAnswer{
		Schema: applianceAnswerSchema, Operation: operation, TransactionID: transactionID,
		TargetSerial: target.Serial, EraseConfirmed: eraseConfirmed, Network: w.networkAnswer(),
		ReleasePolicy: w.releasePolicyAnswer(), Development: w.developmentPolicy,
	}
	if w.sshCur == 1 {
		answer.AuthorizedKeys = []string{strings.TrimSpace(w.sshInput.Value())}
	}
	if err := validateApplianceAnswer(answer); err != nil {
		return applianceAnswer{}, err
	}
	return answer, nil
}

func (w applianceWizardModel) preserveEligibility() error {
	target, err := w.selectedDisk()
	if err != nil {
		return err
	}
	installed, ok := w.installed[target.Path]
	if !ok {
		return fmt.Errorf("preserve reinstall requires a trusted existing YouEye installation")
	}
	if err := ordering.RequireUpgradeIdentity(installed.ImageVersion, w.bundle.Manifest.ImageVersion); err != nil {
		return fmt.Errorf("preserve reinstall is unavailable: %w", err)
	}
	return nil
}

func (w applianceWizardModel) targetIsNonBlank() bool {
	target, err := w.selectedDisk()
	if err != nil {
		return false
	}
	return len(nonBlankSignatures(target.Signatures)) > 0
}

func (w applianceWizardModel) finish() (applianceWizardModel, tea.Cmd) {
	transactionID, err := newApplianceTransactionID()
	if err != nil {
		w.inputErr = err.Error()
		return w, nil
	}
	answer, err := w.currentAnswer(true, transactionID)
	if err != nil {
		w.inputErr = err.Error()
		return w, nil
	}
	if err := writeApplianceAnswerFile(w.answerPath, answer); err != nil {
		w.inputErr = err.Error()
		return w, nil
	}
	w.config.ApplianceAnswerPath = w.answerPath
	w.done = true
	return w, nil
}

func writeApplianceAnswerFile(path string, answer applianceAnswer) error {
	if err := validateApplianceAnswer(answer); err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("create appliance answer directory: %w", err)
	}
	raw, err := json.MarshalIndent(answer, "", "  ")
	if err != nil {
		return fmt.Errorf("encode appliance answer: %w", err)
	}
	raw = append(raw, '\n')
	tmp, err := os.CreateTemp(dir, ".interactive-answer-*")
	if err != nil {
		return fmt.Errorf("create appliance answer: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return fmt.Errorf("protect appliance answer: %w", err)
	}
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return fmt.Errorf("write appliance answer: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("sync appliance answer: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close appliance answer: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("activate appliance answer: %w", err)
	}
	return nil
}

func (w applianceWizardModel) View() string {
	var title, body, hint string
	step := ""
	switch {
	case w.err != nil:
		title = "Installer preflight failed"
		body = theme.Danger.Render(strings.Join(wrapText(w.err.Error(), 66), "\n"))
		hint = "Ctrl+C exits without changing disks"
	case w.stage == applianceWizardLoading:
		title = "YouEye Installer"
		body = theme.Body.Render("Verifying the signed release and discovering target disks...")
		hint = "No target disk has been changed"
	case w.stage == applianceWizardTarget:
		title, step = "Choose installation drive", "Step 1"
		body = w.diskListView(w.targetCur)
		hint = "Up/Down select | Enter continue | Esc exit"
	case w.stage == applianceWizardOperation:
		title, step = "Choose installation type", "Step 2"
		body = w.operationView()
		hint = "Up/Down select | Enter continue | Esc back"
	case w.stage == applianceWizardNetwork:
		title, step = "Network", "Next step"
		body = w.networkView()
		hint = "A adapter | Up/Down mode | Tab fields | Enter continue | Esc back"
	case w.stage == applianceWizardRelease:
		title, step = "Software", "Next step"
		body = w.releaseView()
		hint = "Up/Down track | Left/Right source | F freshness | Tab fields | Enter continue"
	case w.stage == applianceWizardSSH:
		title, step = "SSH access", "Next step"
		body = w.sshView()
		hint = "Up/Down select | Enter continue | Esc back"
	case w.stage == applianceWizardDevelopment:
		title, step = "Development access", "Next step"
		body = w.developmentView()
		hint = "Up/Down move | Space toggle | Enter continue | Esc back"
	case w.stage == applianceWizardReview:
		title, step = "Review installation", "Final review"
		body = w.reviewView()
		hint = "Enter confirms this plan | Esc back"
	case w.stage == applianceWizardErase:
		if w.isPreserveReinstall() {
			title = "Confirm preserve reinstall"
		} else {
			title = "Confirm disk erasure"
		}
		body = w.eraseView()
		hint = "Up/Down choose | Enter confirm | Esc back"
	}
	parts := []string{}
	if step != "" {
		parts = append(parts, theme.Dim.Render(step))
	}
	parts = append(parts, theme.Title.Render(title), theme.Dim.Render(strings.Repeat("-", 68)), "", body)
	if w.inputErr != "" {
		parts = append(parts, "", theme.Danger.Render(strings.Join(wrapText(w.inputErr, 66), "\n")))
	}
	parts = append(parts, "", theme.Dim.Render(strings.Repeat("-", 68)), theme.Hint.Render(hint))
	boxed := theme.Box.Render(lipgloss.JoinVertical(lipgloss.Left, parts...))
	if w.width > 0 {
		return lipgloss.Place(w.width, w.height, lipgloss.Center, lipgloss.Center, boxed)
	}
	return boxed
}

func (w applianceWizardModel) isPreserveReinstall() bool {
	target, err := w.selectedDisk()
	if err != nil {
		return false
	}
	_, installed := w.installed[target.Path]
	return installed && w.operationCur == 0
}

func (w applianceWizardModel) operationView() string {
	preserveDescription := "Replace System A/B and Recovery; retain settings, identity, SSH keys, apps, and data"
	if err := w.preserveEligibility(); err != nil {
		preserveDescription = err.Error()
	}
	rows := []string{
		w.radioLine(0, w.operationCur, "Preserve settings and data", preserveDescription),
		w.radioLine(1, w.operationCur, "Erase and install from scratch", "Permanently remove the existing system, settings, applications, and data"),
	}
	return strings.Join(rows, "\n")
}

func (w applianceWizardModel) diskListView(cursor int) string {
	rows := []string{theme.Dim.Render(fmt.Sprintf("Minimum %s | Recommended %s", formatBytes(applianceTargetMinBytes), formatBytes(applianceRecommendedBytes))), ""}
	for i, disk := range w.disks {
		prefix := "  "
		style := theme.Body
		if i == cursor {
			prefix = "> "
			style = theme.Selected
		}
		model := strings.TrimSpace(disk.Model)
		if model == "" {
			model = "Unknown model"
		}
		rows = append(rows, style.Render(prefix+shortApplianceText(model, 26)+"  "+disk.Path))
		identity := fmt.Sprintf("    %s | serial %s", formatBytes(disk.SizeBytes), shortApplianceText(disk.Serial, 28))
		rows = append(rows, theme.Dim.Render(identity))
		if signatures := nonBlankSignatures(disk.Signatures); len(signatures) > 0 {
			rows = append(rows, theme.Danger.Render("    Existing contents: "+shortApplianceText(strings.Join(signatures, ", "), 48)))
		} else {
			rows = append(rows, theme.Dim.Render("    Blank disk"))
		}
		if installed, ok := w.installed[disk.Path]; ok {
			rows = append(rows, theme.Dim.Render(fmt.Sprintf("    Trusted YouEye: %s", installed.ImageVersion)))
		}
		if warning := w.identityWarnings[disk.Path]; warning != "" {
			rows = append(rows, theme.Danger.Render("    "+shortApplianceText(warning, 58)))
		}
		if err := w.diskCandidateError(i); err != nil {
			rows = append(rows, theme.Danger.Render("    Unavailable: "+shortApplianceText(err.Error(), 52)))
		}
		rows = append(rows, "")
	}
	return strings.Join(rows, "\n")
}

func (w applianceWizardModel) networkView() string {
	adapter := "Automatic wired adapter"
	if w.networkAdapter >= 0 && w.networkAdapter < len(w.adapters) {
		selected := w.adapters[w.networkAdapter]
		adapter = fmt.Sprintf("%s · %s", selected.Name, selected.MAC)
	}
	rows := []string{
		fmt.Sprintf("  Wired adapter  %s  (A to change)", adapter), "",
		w.radioLine(0, w.networkCur, "Wired DHCP", "Recommended; configure automatically"),
		w.radioLine(1, w.networkCur, "Static IPv4", "Set address, gateway, and DNS"),
	}
	if w.networkCur == 1 {
		labels := []string{"Address/CIDR", "Gateway", "DNS"}
		rows = append(rows, "")
		for i, label := range labels {
			rows = append(rows, fmt.Sprintf("  %-13s %s", label+":", w.networkInputs[i].View()))
		}
	}
	return strings.Join(rows, "\n")
}

func (w applianceWizardModel) releaseView() string {
	labels := []struct{ title, detail string }{
		{"Latest Stable", "Recommended public release track"},
		{"Latest Development", "Newest signed development release"},
		{"Signed branch track", "Latest signed release associated with a named branch"},
		{"Exact signed release", "Immutable tag and signed appliance-manifest digest; no fallback"},
	}
	rows := []string{
		fmt.Sprintf("  Release source  %s  (Left/Right)", releaseProviderLabel(w.releaseProvider)),
		fmt.Sprintf("  Freshness       %s  (F)", w.releaseFreshness), "",
	}
	for index, option := range labels {
		rows = append(rows, w.radioLine(index, w.releaseCur, option.title, option.detail))
	}
	for _, key := range w.releaseInputKeys() {
		label := map[string]string{"api": "Releases API", "branch": "Branch", "tag": "Exact tag", "digest": "Manifest SHA-256"}[key]
		rows = append(rows, fmt.Sprintf("  %-17s %s", label+":", w.releaseInputs[key].View()))
	}
	rows = append(rows, "", theme.Dim.Render("The installed System comes from this media; first boot may update A/B before installing the Server interface."))
	return strings.Join(rows, "\n")
}

func (w applianceWizardModel) sshView() string {
	rows := []string{
		w.radioLine(0, w.sshCur, "No SSH key", "Public-key SSH remains disabled unless added later"),
		w.radioLine(1, w.sshCur, "Paste public key", "Authorize one public key for root SSH access"),
	}
	if w.sshCur == 1 {
		rows = append(rows, "", "  "+w.sshInput.View())
	}
	return strings.Join(rows, "\n")
}

func (w applianceWizardModel) developmentView() string {
	rows := []string{
		fmt.Sprintf("%s%-20s %s", w.cursorPrefix(0), "Root console", "Always available · password authenticated"),
		w.toggleLine(1, "Root password SSH", w.developmentSSH, "Limit password sign-in to the directly connected local network"),
	}
	rows = append(rows,
		fmt.Sprintf("%s%-20s %s", w.cursorPrefix(2), "Root password", w.developmentInputs[0].View()),
		fmt.Sprintf("%s%-20s %s", w.cursorPrefix(3), "Confirm password", w.developmentInputs[1].View()),
	)
	rows = append(rows, w.cursorPrefix(4)+"Continue")
	rows = append(rows, "", theme.Dim.Render("The local shell always requires this password. Password SSH remains optional and local-subnet only. Only a yescrypt hash is stored."))
	return strings.Join(rows, "\n")
}

func (w applianceWizardModel) cursorPrefix(index int) string {
	if w.developmentCur == index {
		return theme.Selected.Render("> ")
	}
	return "  "
}

func (w applianceWizardModel) toggleLine(index int, label string, enabled bool, detail string) string {
	state := "Off"
	if enabled {
		state = "Enabled"
	}
	return fmt.Sprintf("%s%-24s %s\n%s", w.cursorPrefix(index), label, state, theme.Dim.Render("    "+detail))
}

func (w applianceWizardModel) radioLine(index, cursor int, label, description string) string {
	prefix := "  "
	style := theme.Body
	if index == cursor {
		prefix = "> "
		style = theme.Selected
	}
	return style.Render(prefix+label) + "\n" + theme.Dim.Render("    "+description)
}

func (w applianceWizardModel) reviewView() string {
	target, _ := w.selectedDisk()
	network := "Wired DHCP"
	if w.networkCur == 1 {
		network = "Static IPv4 " + w.networkInputs[0].Value()
	}
	ssh := "No SSH key"
	if w.sshCur == 1 {
		ssh = "Public key " + shortApplianceText(w.sshInput.Value(), 24)
	}
	rows := []string{
		fmt.Sprintf("Image:       %s", w.bundle.Manifest.ImageVersion),
		fmt.Sprintf("Source:      %s", shortApplianceText(w.bundle.Manifest.SourceCommit, 40)),
		fmt.Sprintf("Trust:       %s", w.bundle.Manifest.Trust.Class),
		"",
		fmt.Sprintf("Drive:       %s  %s  serial %s", target.Path, formatBytes(target.SizeBytes), shortApplianceText(target.Serial, 24)),
		"",
		"Layout: 1 GiB ESP | 4 GiB Recovery | 8 GiB A | 8 GiB B | 4 GiB State",
		"        YE-DATA uses the remaining drive capacity",
		"Network: " + network,
		fmt.Sprintf("Software: %s · %s", releaseProviderLabel(w.releasePolicyAnswer().Provider), w.releasePolicySummary()),
		"SSH:     " + ssh,
		fmt.Sprintf("Developer console: %s", enabledLabel(w.developmentPolicy.LocalRootConsole)),
		fmt.Sprintf("Root password SSH: %s", enabledLabel(w.developmentPolicy.RootPasswordSSH)),
	}
	if w.networkAdapter >= 0 && w.networkAdapter < len(w.adapters) {
		selected := w.adapters[w.networkAdapter]
		rows = append(rows, fmt.Sprintf("Adapter: %s · %s", selected.Name, selected.MAC))
	}
	if w.isPreserveReinstall() {
		rows = append(rows, "Operation: Preserve settings, identity, SSH keys, applications, and data")
	} else {
		rows = append(rows, "Operation: Full erase and fresh install")
	}
	if installed, ok := w.installed[target.Path]; ok {
		rows = append(rows, fmt.Sprintf("Existing: Trusted YouEye %s", installed.ImageVersion))
	} else if warning := w.identityWarnings[target.Path]; warning != "" {
		rows = append(rows, "Existing: Untrusted or unreadable YouEye metadata")
	}
	if w.isPreserveReinstall() {
		rows = append(rows, "", theme.Danger.Render("System A/B, Recovery, and boot assets will be replaced. State and YE-DATA will remain."))
	} else if w.targetIsNonBlank() {
		rows = append(rows, "", theme.Danger.Render("Existing contents were detected. The next step confirms a complete erase."))
	} else {
		rows = append(rows, "", theme.Danger.Render("The selected drive will be repartitioned and erased."))
	}
	return strings.Join(rows, "\n")
}

func enabledLabel(enabled bool) string {
	if enabled {
		return "Enabled"
	}
	return "Off"
}

func (w applianceWizardModel) releasePolicySummary() string {
	policy := w.releasePolicyAnswer()
	if policy.Mode == "exact" {
		return "Exact " + policy.ExactTag
	}
	if policy.Track == "branch" {
		return "Branch " + policy.Branch
	}
	return strings.Title(policy.Track)
}

func (w applianceWizardModel) eraseView() string {
	target, _ := w.selectedDisk()
	no := "  No, go back"
	yes := "  Yes, erase and install"
	if w.isPreserveReinstall() {
		yes = "  Yes, reinstall and preserve data"
	}
	if w.eraseCur == 0 {
		no = theme.Selected.Render("> No, go back")
	} else {
		yes = theme.Selected.Render("> Yes, erase and install")
	}
	if w.isPreserveReinstall() {
		return strings.Join([]string{
			theme.Danger.Render("This replaces the operating system on the selected installation drive:"),
			fmt.Sprintf("  %s  %s  serial %s", target.Path, target.Model, target.Serial),
			"",
			"Machine identity, network settings, SSH keys, applications, and YE-DATA are preserved.",
			"",
			no,
			yes,
		}, "\n")
	}
	return strings.Join([]string{
		theme.Danger.Render("This permanently erases the selected installation drive:"),
		fmt.Sprintf("  %s  %s  serial %s", target.Path, target.Model, target.Serial),
		"",
		theme.Danger.Render("All existing systems, settings, applications, and data on this drive will be lost."),
		"",
		no,
		yes,
	}, "\n")
}

func shortApplianceText(value string, limit int) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "unknown"
	}
	if len(value) <= limit {
		return value
	}
	if limit <= 3 {
		return value[:limit]
	}
	return value[:limit-3] + "..."
}
