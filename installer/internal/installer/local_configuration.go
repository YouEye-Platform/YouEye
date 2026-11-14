package installer

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/youeye-platform/YouEye/installer/internal/installer/theme"
)

const (
	localBootstrapRoot      = "/var/lib/youeye-state/bootstrap"
	localNetworkApply       = "/usr/local/bin/youeye boot network" // the network check ships with Spine
	localNetworkProfileName = "network-profile.json"
)

type localApplyRunner interface {
	Run(string) error
}

type localExecRunner struct{}

func (localExecRunner) Run(commandLine string) error {
	fields := strings.Fields(commandLine)
	command := exec.Command(fields[0], fields[1:]...)
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	return command.Run()
}

type localNetworkProfile struct {
	Schema     string           `json:"schema"`
	ID         string           `json:"id"`
	Kind       string           `json:"kind"`
	AdapterMAC string           `json:"adapter_mac,omitempty"`
	IPv4       localIPv4Profile `json:"ipv4"`
}

type localIPv4Profile struct {
	Mode    string   `json:"mode"`
	Address string   `json:"address,omitempty"`
	Gateway string   `json:"gateway,omitempty"`
	DNS     []string `json:"dns,omitempty"`
}

func validateLocalNetworkProfile(profile localNetworkProfile) error {
	if profile.Schema != "youeye.network-profile.v1" || profile.ID != "primary" || profile.Kind != "ethernet" {
		return errors.New("the wired network profile identity is invalid")
	}
	if profile.AdapterMAC != "" && !validEthernetMAC(profile.AdapterMAC) {
		return errors.New("the wired adapter identity is invalid")
	}
	switch profile.IPv4.Mode {
	case "dhcp":
		if profile.IPv4.Address != "" || profile.IPv4.Gateway != "" || len(profile.IPv4.DNS) != 0 {
			return errors.New("DHCP cannot include static IPv4 fields")
		}
	case "static":
		address, network, err := net.ParseCIDR(strings.TrimSpace(profile.IPv4.Address))
		if err != nil || address.To4() == nil || network == nil || address.IsUnspecified() || address.IsMulticast() {
			return errors.New("enter a usable static IPv4 address in CIDR form")
		}
		gateway := net.ParseIP(strings.TrimSpace(profile.IPv4.Gateway))
		if gateway == nil || gateway.To4() == nil || !network.Contains(gateway) {
			return errors.New("the IPv4 gateway must be inside the selected subnet")
		}
		if len(profile.IPv4.DNS) != 1 {
			return errors.New("enter one IPv4 DNS server")
		}
		dns := net.ParseIP(strings.TrimSpace(profile.IPv4.DNS[0]))
		if dns == nil || dns.To4() == nil || dns.IsUnspecified() || dns.IsMulticast() {
			return errors.New("enter a usable IPv4 DNS server")
		}
	default:
		return errors.New("choose wired DHCP or static IPv4")
	}
	return nil
}

func applyLocalNetworkProfile(path string, profile localNetworkProfile, runner localApplyRunner) error {
	if err := validateLocalNetworkProfile(profile); err != nil {
		return err
	}
	previous, previousErr := os.ReadFile(path)
	if previousErr != nil && !errors.Is(previousErr, os.ErrNotExist) {
		return fmt.Errorf("read previous wired network profile: %w", previousErr)
	}
	if err := writeProtectedJSON(path, profile); err != nil {
		return err
	}
	if runner == nil {
		runner = localExecRunner{}
	}
	if err := runner.Run(localNetworkApply); err != nil {
		if previousErr == nil {
			_ = writeProtectedBytes(path, previous)
		} else {
			_ = os.Remove(path)
		}
		return fmt.Errorf("the new network profile did not pass connectivity checks; the saved profile was restored: %w", err)
	}
	return nil
}

func writeProtectedJSON(path string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return writeProtectedBytes(path, append(raw, '\n'))
}

func writeProtectedBytes(path string, raw []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".youeye-local-config-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(raw); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	if directory, err := os.Open(filepath.Dir(path)); err != nil {
		return err
	} else if err := directory.Sync(); err != nil {
		directory.Close()
		return err
	} else {
		return directory.Close()
	}
}

type localNetworkModel struct {
	mode       string
	adapters   []applianceNetworkAdapter
	adapterCur int
	inputs     []textinput.Model
	cursor     int
	err        string
	complete   bool
	profile    string
	runner     localApplyRunner
	standalone bool
}

func newLocalNetworkModel(profile string, runner localApplyRunner) localNetworkModel {
	address := textinput.New()
	address.Placeholder = "192.168.1.40/24"
	gateway := textinput.New()
	gateway.Placeholder = "192.168.1.1"
	dns := textinput.New()
	dns.Placeholder = "1.1.1.1"
	adapters, adapterErr := discoverApplianceNetworkAdapters()
	model := localNetworkModel{mode: "dhcp", adapters: adapters, inputs: []textinput.Model{address, gateway, dns}, profile: profile, runner: runner, standalone: true}
	if adapterErr != nil {
		model.err = "Wired adapters could not be enumerated; automatic selection remains available."
	}
	if raw, err := os.ReadFile(profile); err == nil {
		var saved localNetworkProfile
		if json.Unmarshal(raw, &saved) == nil && validateLocalNetworkProfile(saved) == nil {
			model.mode = saved.IPv4.Mode
			for index, adapter := range model.adapters {
				if adapter.MAC == saved.AdapterMAC {
					model.adapterCur = index
					break
				}
			}
			model.inputs[0].SetValue(saved.IPv4.Address)
			model.inputs[1].SetValue(saved.IPv4.Gateway)
			if len(saved.IPv4.DNS) == 1 {
				model.inputs[2].SetValue(saved.IPv4.DNS[0])
			}
		}
	}
	return model
}

func (model localNetworkModel) Init() tea.Cmd { return nil }

func (model localNetworkModel) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	key, ok := message.(tea.KeyMsg)
	if !ok {
		return model, nil
	}
	if key.String() == "ctrl+c" || key.String() == "esc" {
		return model, tea.Quit
	}
	if model.complete {
		if key.String() == "enter" || key.String() == "q" {
			return model, tea.Quit
		}
		return model, nil
	}
	if model.cursor >= 1 && model.cursor <= 3 && model.mode == "static" {
		switch key.String() {
		case "tab", "down":
			model.inputs[model.cursor-1].Blur()
			model.cursor++
			return model, model.focusNetworkInput()
		case "shift+tab", "up":
			model.inputs[model.cursor-1].Blur()
			model.cursor--
			return model, model.focusNetworkInput()
		}
		var command tea.Cmd
		model.inputs[model.cursor-1], command = model.inputs[model.cursor-1].Update(key)
		return model, command
	}
	switch key.String() {
	case "a":
		if len(model.adapters) > 1 {
			model.adapterCur = (model.adapterCur + 1) % len(model.adapters)
		}
		model.err = ""
	case "up", "shift+tab":
		model.cursor--
	case "down", "tab":
		model.cursor++
	case "left", "right", " ":
		if model.cursor == 0 {
			if model.mode == "dhcp" {
				model.mode = "static"
			} else {
				model.mode = "dhcp"
			}
		}
	case "enter":
		if model.cursor == 0 {
			if model.mode == "dhcp" {
				model.mode = "static"
			} else {
				model.mode = "dhcp"
			}
		} else if model.cursor == 4 {
			profile := localNetworkProfile{Schema: "youeye.network-profile.v1", ID: "primary", Kind: "ethernet", IPv4: localIPv4Profile{Mode: model.mode}}
			if model.adapterCur >= 0 && model.adapterCur < len(model.adapters) {
				profile.AdapterMAC = model.adapters[model.adapterCur].MAC
			}
			if model.mode == "static" {
				profile.IPv4.Address = strings.TrimSpace(model.inputs[0].Value())
				profile.IPv4.Gateway = strings.TrimSpace(model.inputs[1].Value())
				profile.IPv4.DNS = []string{strings.TrimSpace(model.inputs[2].Value())}
			}
			if err := applyLocalNetworkProfile(model.profile, profile, model.runner); err != nil {
				model.err = err.Error()
			} else {
				model.err = ""
				model.complete = true
			}
		}
	}
	if model.mode == "dhcp" {
		if model.cursor > 0 && model.cursor < 4 {
			model.cursor = 4
		}
	} else if model.cursor > 4 {
		model.cursor = 0
	}
	if model.cursor < 0 {
		model.cursor = 4
	}
	if model.cursor > 4 {
		model.cursor = 0
	}
	return model, model.focusNetworkInput()
}

func (model *localNetworkModel) focusNetworkInput() tea.Cmd {
	for index := range model.inputs {
		model.inputs[index].Blur()
	}
	if model.mode == "static" && model.cursor >= 1 && model.cursor <= 3 {
		return model.inputs[model.cursor-1].Focus()
	}
	return nil
}

func (model localNetworkModel) View() string {
	if model.complete {
		return localPanel("Network ready", "The wired profile passed link, address, route, DNS, clock, and HTTPS checks.\n\nPress Enter to return.")
	}
	rows := []string{
		theme.Title.Render("Host network"), "",
		"Configure the wired IPv4 connection used before the Server interface is available.",
		"Wi-Fi is not supported by this appliance release.", "",
		"Wired adapter  " + model.adapterLabel() + "  (A to change)",
		localCursor(model.cursor, 0) + "Mode       " + strings.ToUpper(model.mode) + "  (Left/Right)",
	}
	if model.mode == "static" {
		rows = append(rows,
			localCursor(model.cursor, 1)+"Address    "+model.inputs[0].View(),
			localCursor(model.cursor, 2)+"Gateway    "+model.inputs[1].View(),
			localCursor(model.cursor, 3)+"DNS        "+model.inputs[2].View(),
		)
	}
	rows = append(rows, "", localCursor(model.cursor, 4)+"Apply and test", "", theme.Dim.Render("A adapter · Up/Down move · Enter select · Esc return"))
	if model.err != "" {
		rows = append(rows, "", theme.Danger.Render(strings.Join(wrapText(model.err, 66), "\n")))
	}
	return localPanelContent(rows)
}

func (model localNetworkModel) adapterLabel() string {
	if model.adapterCur >= 0 && model.adapterCur < len(model.adapters) {
		adapter := model.adapters[model.adapterCur]
		return adapter.Name + " · " + adapter.MAC
	}
	return "Automatic"
}

func localCursor(cursor, row int) string {
	if cursor == row {
		return theme.Selected.Render("› ")
	}
	return "  "
}

func localPanel(title, detail string) string {
	return localPanelContent([]string{theme.Title.Render(title), "", detail})
}

func localPanelContent(rows []string) string {
	return theme.BoxAccent.Width(72).Render(strings.Join(rows, "\n"))
}

func runLocalModel(model tea.Model) error {
	program := tea.NewProgram(model, tea.WithAltScreen())
	_, err := program.Run()
	return err
}

// RunLocalNetworkConfiguration opens the supported on-device wired network TUI.
func RunLocalNetworkConfiguration() error {
	return runLocalModel(newLocalNetworkModel(filepath.Join(localBootstrapRoot, localNetworkProfileName), nil))
}
