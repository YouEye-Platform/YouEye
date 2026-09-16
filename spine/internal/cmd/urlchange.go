package cmd

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/youeye-platform/YouEye/spine/internal/output"
	"gopkg.in/yaml.v3"
)

// platformYamlState is the subset of youeye.yaml the URL-change commands need.
type platformYamlState struct {
	Domain         string `yaml:"domain,omitempty"`
	SetupCompleted bool   `yaml:"setup_completed,omitempty"`
}

// readPlatformYaml reads /var/lib/youeye/config/youeye.yaml from the host.
// Returns a zero value (SetupCompleted=false) when the file doesn't exist yet.
func readPlatformYaml() platformYamlState {
	var state platformYamlState
	data, err := os.ReadFile(youeyeConfigPath)
	if err != nil {
		return state
	}
	_ = yaml.Unmarshal(data, &state)
	return state
}

// confirmURLChange prints what a server URL change does and asks for consent.
// Returns true when the user (or --yes) approves.
func confirmURLChange(newDomain, currentDomain string, selfsigned bool, yes bool) bool {
	fmt.Println()
	if currentDomain != "" {
		output.Info(fmt.Sprintf("This changes the server URL: %s → %s", currentDomain, newDomain))
	} else {
		output.Info("This changes the server URL to " + newDomain)
	}
	output.Info("  • Everyone is signed out and must sign in again at the new address")
	output.Info("  • Installed apps restart briefly while they move to the new name")
	output.Info(fmt.Sprintf("  • Other devices need DNS pointing %s and *.%s at this server", newDomain, newDomain))
	if selfsigned {
		output.Info("  • Browsers will warn until the new self-signed certificate is trusted")
	}
	if yes {
		return true
	}
	fmt.Print("\nContinue? [y/N]: ")
	reader := bufio.NewReader(os.Stdin)
	answer, _ := reader.ReadString('\n')
	answer = strings.ToLower(strings.TrimSpace(answer))
	if answer != "y" && answer != "yes" {
		output.Warn("Cancelled")
		return false
	}
	return true
}

// reconfigureEvent mirrors the Control Panel reconfigure engine's SSE payloads.
type reconfigureEvent struct {
	Step     string `json:"step,omitempty"`
	Status   string `json:"status,omitempty"`
	Message  string `json:"message,omitempty"`
	Complete bool   `json:"complete,omitempty"`
	NewURL   string `json:"newUrl,omitempty"`
	Error    string `json:"error,omitempty"`
}

// streamURLChange POSTs to a reconfigure-style SSE endpoint on the Control
// Panel and renders step progress. Returns an error when the stream reports
// one or never completes.
func streamURLChange(path string, payload interface{}) error {
	var failure error
	var newURL string

	err := controlClient.PostSSEJSON(path, payload, func(raw string) {
		if raw == "[DONE]" {
			return
		}
		var evt reconfigureEvent
		if json.Unmarshal([]byte(raw), &evt) != nil {
			return
		}
		switch {
		case evt.Error != "":
			failure = fmt.Errorf("%s", evt.Error)
		case evt.Complete:
			newURL = evt.NewURL
		case evt.Step != "" && evt.Step != "complete":
			label := evt.Step
			if strings.HasPrefix(label, "app_") {
				label = "app " + strings.TrimPrefix(label, "app_")
			}
			switch evt.Status {
			case "done":
				if evt.Message != "" {
					output.Success(fmt.Sprintf("%s — %s", label, evt.Message))
				} else {
					output.Success(label)
				}
			case "error":
				output.Error(fmt.Sprintf("%s — %s", label, evt.Message))
			default:
				if evt.Message != "" {
					output.Info(fmt.Sprintf("  %s: %s", label, evt.Message))
				}
			}
		}
	})
	if err != nil {
		// The Control Panel restarts itself ~2s after the final event; a
		// connection cut AFTER `complete` arrived is success, not failure.
		if newURL == "" && failure == nil {
			return err
		}
	}
	if failure != nil {
		return failure
	}
	if newURL == "" {
		return fmt.Errorf("the change did not complete — check 'youeye logs control' and retry")
	}
	fmt.Println()
	output.Success("Server URL changed — the platform is now at " + newURL)
	output.Info("Everyone must sign in again. The Control Panel restarts within a few seconds.")
	return nil
}
