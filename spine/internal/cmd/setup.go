package cmd

import (
	"git.byka.wtf/potemsla/YouEye/spine/internal/output"
	"github.com/spf13/cobra"
)

var setupCmd = &cobra.Command{
	Use:   "setup",
	Short: "Setup wizard status and control",
}

var setupStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Check if setup wizard has been completed",
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		data, err := controlClient.Get("/api/setup/config")
		if err != nil {
			return err
		}

		completed := firstOf(data, "setupCompleted", "completed")
		if completed == "true" {
			output.Success("Setup is complete")
		} else {
			output.Warn("Setup has not been completed")
			output.Info("Open the web UI to complete setup")
		}

		if steps, err := controlClient.Get("/api/setup/steps"); err == nil {
			if stepList, ok := steps["steps"].([]interface{}); ok {
				for _, s := range stepList {
					if step, ok := s.(map[string]interface{}); ok {
						name := firstOf(step, "name", "title")
						status := firstOf(step, "status", "completed")
						output.StatusLine(name, status, "")
					}
				}
			}
		}
		return nil
	},
}

var setupReconfigureCmd = &cobra.Command{
	Use:   "reconfigure",
	Short: "Re-run the setup wizard",
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		_, err := controlClient.Post("/api/setup/reconfigure", nil)
		if err != nil {
			return err
		}
		output.Success("Setup wizard has been reset -- open the web UI to reconfigure")
		return nil
	},
}

func init() {
	setupCmd.AddCommand(setupStatusCmd)
	setupCmd.AddCommand(setupReconfigureCmd)
}
