package installer

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
)

type applianceProgressRecord struct {
	Schema    string  `json:"schema"`
	Operation string  `json:"operation"`
	State     string  `json:"state"`
	Stage     string  `json:"stage,omitempty"`
	Detail    string  `json:"detail,omitempty"`
	Percent   float64 `json:"percent"`
	Result    string  `json:"result,omitempty"`
}

func RunInstallerMediaSilent(opts CLIOptions) error {
	if !opts.Yes {
		return fmt.Errorf("--silent requires --yes")
	}
	return runSilentInstaller(configFromOptions(opts), os.Stdout)
}

func runSilentInstaller(config installConfig, output io.Writer) error {
	encoder := json.NewEncoder(output)
	if err := encoder.Encode(applianceProgressRecord{
		Schema: "youeye.installer.progress.v1", Operation: "install", State: "starting", Percent: 0,
	}); err != nil {
		return fmt.Errorf("write installer progress: %w", err)
	}
	for message := range startEngine(config) {
		record := applianceProgressRecord{
			Schema: "youeye.installer.progress.v1", Operation: "install",
			State: "running", Stage: message.StepName, Detail: message.LogLine, Percent: message.Percent,
		}
		if message.Err != nil {
			record.State = "failed"
			record.Detail = message.Err.Error()
			if err := encoder.Encode(record); err != nil {
				return fmt.Errorf("write installer failure progress: %w", err)
			}
			return message.Err
		}
		if message.Done {
			record.State = "complete"
			record.Percent = 1
			record.Result = message.ResultIP
		}
		if err := encoder.Encode(record); err != nil {
			return fmt.Errorf("write installer progress: %w", err)
		}
		if message.Done {
			return nil
		}
	}
	return fmt.Errorf("installer stopped before completion")
}
