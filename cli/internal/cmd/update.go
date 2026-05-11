package cmd

import (
	"git.byka.wtf/potemsla/YouEye/cli/internal/client"
	"git.byka.wtf/potemsla/YouEye/cli/internal/output"
	"github.com/spf13/cobra"
)

var updateCmd = &cobra.Command{
	Use:   "update",
	Short: "Update platform components",
}

var updateSelfCmd = &cobra.Command{
	Use:   "self",
	Short: "Update Spine to the latest version",
	RunE: func(cmd *cobra.Command, args []string) error {
		output.Info("Updating Spine...")
		result, err := spine.Post("/api/update/self", nil)
		if err != nil {
			return err
		}
		output.Success("Spine: " + str(result, "message"))
		return nil
	},
}

var updateControlCmd = &cobra.Command{
	Use:   "control",
	Short: "Update Control Panel to the latest version",
	RunE: func(cmd *cobra.Command, args []string) error {
		output.Info("Updating Control Panel...")
		err := spine.PostStream("/api/update/control", nil, func(line string) {
			output.Info(line)
		})
		if err != nil {
			return err
		}
		output.Success("Control Panel updated")
		return nil
	},
}

var updateUICmd = &cobra.Command{
	Use:   "ui",
	Short: "Update YouEye UI to the latest version",
	RunE: func(cmd *cobra.Command, args []string) error {
		if !requireCP() {
			return nil
		}
		output.Info("Updating UI...")
		return cp.PostSSE("/api/updates/ui", nil, func(event client.SSEEvent) {
			output.SSEProgress(event.Step, event.TotalSteps, event.Status, event.Message)
		})
	},
}

var updateSystemCmd = &cobra.Command{
	Use:   "system",
	Short: "Update host OS packages",
	RunE: func(cmd *cobra.Command, args []string) error {
		output.Info("Updating system packages...")
		result, err := spine.Post("/api/update/system", nil)
		if err != nil {
			return err
		}
		output.Success("System: " + str(result, "message"))
		return nil
	},
}

var updateIncusCmd = &cobra.Command{
	Use:   "incus",
	Short: "Update Incus to the latest version",
	RunE: func(cmd *cobra.Command, args []string) error {
		output.Info("Updating Incus...")
		result, err := spine.Post("/api/update/incus", nil)
		if err != nil {
			return err
		}
		output.Success("Incus: " + str(result, "message"))
		return nil
	},
}

var updateCheckCmd = &cobra.Command{
	Use:   "check",
	Short: "Check all components for available updates",
	RunE: func(cmd *cobra.Command, args []string) error {
		output.Info("Checking for updates...")

		// Spine updates [S]
		output.Section("Infrastructure")
		if data, err := spine.Get("/api/updates/check"); err == nil {
			if spineUpdate := str(data, "spine"); spineUpdate != "" {
				output.StatusLine("Spine", spineUpdate+" available", output.Yellow)
			} else {
				output.StatusLine("Spine", "up to date", output.Green)
			}
			if sysUpdates := str(data, "system_updates"); sysUpdates != "" && sysUpdates != "0" {
				output.StatusLine("System", sysUpdates+" packages", output.Yellow)
			} else {
				output.StatusLine("System", "up to date", output.Green)
			}
		} else {
			output.Error("Could not check Spine updates: " + err.Error())
		}

		// CP + app updates [CP]
		if cp.Available() {
			output.Section("Apps")
			if data, err := cp.Get("/api/updates/status"); err == nil {
				if updates, ok := data["updates"].([]interface{}); ok {
					hasUpdates := false
					for _, u := range updates {
						if upd, ok := u.(map[string]interface{}); ok {
							name := firstOf(upd, "name", "component")
							current := firstOf(upd, "currentVersion")
							available := firstOf(upd, "availableVersion", "latestVersion")
							if available != "" && available != current {
								output.StatusLine(name, current+" -> "+available, output.Yellow)
								hasUpdates = true
							}
						}
					}
					if !hasUpdates {
						output.Success("All components up to date")
					}
				}
			}
		} else {
			output.Warn("Control Panel unreachable — cannot check app updates")
		}

		return nil
	},
}

func init() {
	updateCmd.AddCommand(updateSelfCmd)
	updateCmd.AddCommand(updateControlCmd)
	updateCmd.AddCommand(updateUICmd)
	updateCmd.AddCommand(updateSystemCmd)
	updateCmd.AddCommand(updateIncusCmd)
	updateCmd.AddCommand(updateCheckCmd)
}
